/**
 * tee-log.mjs — 控制台输出同时追加落盘到日志文件（每次打版独立文件）。
 *
 * 包装 process.stdout / process.stderr 的 write：写控制台的同时**即时追加**到日志文件
 * （flags:'a'，每次 write 立即落盘，执行到哪一步就写到哪一步，不等到结束）。
 *
 * 支持运行时重命名（异步）：版本号在交互中途才确定，用 await tee.renameTo(newName)。
 * 实现：先 fd.close() 等句柄释放（Windows 无法 rename 正被写入的文件），再 rename、重开句柄。
 *
 * 用法：
 *   import { startTee } from './lib/tee-log.mjs'
 *   const tee = startTee('logs/release-20260901-2113.log')
 *   // ... 边执行边追加 ...
 *   await tee.renameTo('deepseek-harness-desktop-0.2.2-20260901-2113.log')
 *   tee.stop()
 *
 * 日志文件路径自动 mkdir；写日志失败静默（不打断主流程）。
 */
import { createWriteStream, mkdirSync, renameSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { stdout, stderr } from 'node:process'

/** 剥离 ANSI 转义序列（颜色/光标控制码），日志文件只留纯文本。 */
const ANSI_RE = /\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*(\x07|\x1b\\)|\x1b[()][A-Z0-9]/g
function stripAnsi(s) { return String(s).replace(ANSI_RE, '') }

export function startTee(file) {
  const abs = join(process.cwd(), file)
  mkdirSync(dirname(abs), { recursive: true })
  const state = { abs, paused: false }

  const open = () => {
    state.fd = createWriteStream(state.abs, { flags: 'a', encoding: 'utf8', autoClose: false })
  }

  const origOut = stdout.write
  const origErr = stderr.write

  stdout.write = (chunk, ...rest) => {
    try { if (!state.paused) state.fd?.write(stripAnsi(chunk)) } catch { /* 忽略 */ }
    return origOut.call(stdout, chunk, ...rest)
  }
  stderr.write = (chunk, ...rest) => {
    try { if (!state.paused) state.fd?.write(stripAnsi(chunk)) } catch { /* 忽略 */ }
    return origErr.call(stderr, chunk, ...rest)
  }

  open()

  return {
    get path() { return state.abs },
    /** 暂停写日志（交互输入期间用，只显示控制台不落盘）；resume() 恢复。 */
    pause() { state.paused = true },
    resume() { state.paused = false },
    /** 改名（异步）：等旧句柄关闭后 rename，再重开。失败静默返回旧 path。 */
    renameTo(newName) {
      return new Promise((resolve) => {
        const newAbs = join(dirname(state.abs), newName)
        if (!state.fd) return resolve(state.abs)
        state.fd.end(() => {
          try { renameSync(state.abs, newAbs); state.abs = newAbs } catch { /* 忽略 */ }
          open()
          resolve(state.abs)
        })
      })
    },
    /** 结束 tee（异步）：恢复输出，等日志句柄 flush 关闭。 */
    stop() {
      stdout.write = origOut
      stderr.write = origErr
      return new Promise((resolve) => {
        if (state.fd) state.fd.end(() => resolve())
        else resolve()
      })
    },
  }
}

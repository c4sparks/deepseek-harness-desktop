/**
 * select.mjs — 零依赖箭头选择器（↑/↓ 选择，Enter 确认，选中项绿色高亮）。
 *
 * 用 process.stdin raw mode 读按键，不引入任何第三方依赖：
 *   - ↑ / ↓ 或 k / j：移动选中
 *   - Enter：确认返回选中值
 *   - q / Esc / Ctrl+C：取消（返回 null）
 *
 * 重绘策略（保证 widget 只占自己的行数、绝不影响周边文字）：
 *   - **隐藏光标**（`\x1b[?25l`，结束恢复 `\x1b[?25h`）——避免残留光标
 *   - **label 截断**（每行强制单行，超宽省略号）——杜绝折行导致清除错位
 *   - **保存光标位置 → 清到屏幕末尾 → 重绘**（`\x1b[s` / `\x1b[u`+`\x1b[0J`）——
 *     每次重绘从 widget 起点开始覆盖自己的区域，上方/下方文字不动
 *
 * 平台：Windows 10+（需 ANSI VT，Windows Terminal 默认开）、macOS、Linux 均可。
 * 终端不支持 ANSI 时退化为**编号菜单 + 输数字**（仍可用，无高亮）。
 * 非 TTY（管道/CI）返回 default 或第一个选项。
 *
 * 用法：
 *   import { select } from './lib/select.mjs'
 *   const v = await select('选择通道', [
 *     { value: 'npm',   label: 'npm（已发布版本）' },
 *     { value: 'source', label: 'source（本地源码）' },
 *   ])
 *   // v === 'npm' | 'source' | null
 */
import { stdin as procStdin, stdout as procStdout } from 'node:process'

const GREEN = '\x1b[1;92m' // 亮绿 + 加粗（选中项，明显比普通文字亮）
const RESET = '\x1b[39m'
const HIDE_CURSOR = '\x1b[?25l'
const SHOW_CURSOR = '\x1b[?25h'
const SAVE = '\x1b[s' // 保存光标位置
const RESTORE = '\x1b[u' // 恢复到保存的光标位置
const CLEAR_DOWN = '\x1b[0J' // 从光标清到屏幕末尾
const HAS_ANSI = (procStdout.hasColors?.() ?? false) && procStdout.isTTY
const UP = '\x1b[A'
const DOWN = '\x1b[B'
const ESC = '\x1b'

/** 选项 label 最大显示宽度（超宽截断 + 省略号），保证每行单行、不折行。 */
const MAX_LABEL = 60

function clipLabel(label) {
  const s = String(label)
  if (s.length <= MAX_LABEL) return s
  return s.slice(0, MAX_LABEL - 1) + '…'
}

/**
 * @param {string} question 提示文字（单独一行）
 * @param {Array<{value: any, label?: string, hint?: string}>} choices
 * @param {{default?: number, nonInteractive?: any, io?: {in?: any, out?: any}}} opts
 *   io 可选：测试注入 stdin/stdout（默认 process 的）。
 * @returns {Promise<any>} 选中 value；取消返回 null
 */
export async function select(question, choices, opts = {}) {
  if (!choices.length) throw new Error('select: choices 为空')
  const stdin = opts.io?.in ?? procStdin
  const stdout = opts.io?.out ?? procStdout
  const ansi = opts.io ? true : HAS_ANSI // 注入 io 时按支持 ANSI 处理（测试用）
  if (!stdin.isTTY) {
    const def = opts.nonInteractive ?? choices[opts.default ?? 0].value
    const label = choices.find((c) => c.value === def)?.label ?? String(def)
    console.log(`${question} → ${clipLabel(label)}（非交互）`)
    return def
  }
  if (!ansi) return selectPlain(question, choices, opts)

  let index = Math.max(0, Math.min(opts.default ?? 0, choices.length - 1))
  let started = false

  // 箭头列与文字列分离：箭头固定一列（> + 空格，恒 2 格），文字固定左对齐，
  // 选中/未选都从同一列开始 → 箭头上下移动绝不会让文字横向错位。
  // 选中行：绿色箭头 + **绿色加粗文字**（整行高亮）；未选中行：普通文字。
  const ARROW_ON = `${GREEN}> ${RESET}`
  const ARROW_OFF = '  '
  const paint = () => {
    if (started) {
      // 回 widget 起点 → 清到屏幕末尾 → 重绘自己的行
      stdout.write(RESTORE + CLEAR_DOWN)
    } else {
      stdout.write('\n' + SAVE)
      started = true
    }
    const rows = [
      question,
      ...choices.map((c, i) => {
        const label = clipLabel(c.label ?? String(c.value))
        // 选中行：亮绿加粗（高亮）；未选中行：正常亮度普通色（不 DIM，两行亮度一致）
        if (i === index) return `  ${ARROW_ON}${GREEN}${label}${RESET}`
        return `  ${ARROW_OFF}${label}`
      }),
    ]
    stdout.write(rows.join('\n'))
  }

  const finish = (v) => {
    stdout.write('\n' + SHOW_CURSOR)
    stdin.setRawMode(false)
    stdin.pause()
    stdin.removeListener('data', onData)
    resolve(v)
  }

  function onData(buf) {
    const key = String(buf)
    if (key === UP || key === 'k' || key === 'K') {
      index = (index - 1 + choices.length) % choices.length
      paint()
    } else if (key === DOWN || key === 'j' || key === 'J') {
      index = (index + 1) % choices.length
      paint()
    } else if (key === '\r' || key === '\n') {
      finish(choices[index].value)
    } else if (key === 'q' || key === ESC || key === '\x03') {
      finish(null)
    } else {
      paint()
    }
  }

  stdin.setRawMode(true)
  stdin.resume()
  stdin.setEncoding('utf8')
  stdout.write(HIDE_CURSOR)
  paint()

  let resolve
  const done = new Promise((r) => { resolve = r })
  stdin.on('data', onData)
  return done
}

/** 无 ANSI 终端退化：编号菜单 + 输数字。 */
async function selectPlain(question, choices, opts) {
  const { default: def = 0 } = opts
  console.log(`\n${question}`)
  choices.forEach((c, i) => console.log(`  ${i + 1}. ${clipLabel(c.label ?? String(c.value))}`))
  const rl = (await import('node:readline/promises')).createInterface({ input: stdin, output: stdout })
  const ans = (await rl.question(`输入编号（默认 ${def + 1}）: `)).trim()
  rl.close()
  const n = Number(ans || def + 1)
  const i = n >= 1 && n <= choices.length ? n - 1 : def
  return choices[i].value
}

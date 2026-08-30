/**
 * registry.mjs — 下载源统一配置。
 *
 * 默认国内镜像（npmmirror，npmjs 完整镜像），普通用户开箱即用；
 * `DSH_NPM_REGISTRY` 环境变量可覆盖（如公司内网源）。
 */
export const NPM_REGISTRY = process.env.DSH_NPM_REGISTRY || 'https://registry.npmmirror.com'

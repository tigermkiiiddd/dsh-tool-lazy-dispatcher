#!/usr/bin/env node
/**
 * 在 DSH workspace 里跑本仓库的测试。
 *
 * 为什么需要这个脚本：测试跑的是真实 DSH 组件（Context / ToolRuntime / AgentLoop /
 * 原生执行器），而 dsh-agent-loop、dsh-session、dsh-session-projection、
 * dsh-tool-executor-native 这几个包没有发布到 npm，只存在于 DSH monorepo 内部。
 * 裸仓库里直接 `pnpm test` 会因为解析不到它们而失败。
 *
 * 做法：
 *   1. 找到 DSH 仓库（--dsh 参数 / DSH_HOME 环境变量 / 同级目录 deepseek-harness）
 *   2. 把 src/ 和 tests/ 拷进 DSH 的 `packages/<group>/<pkg>/` 两级目录
 *      （DSH 的 vitest include 要求 packages/<group>/<pkg>/tests 两级目录，少一级匹配不到）
 *   3. 用 DSH 自己的 vitest 跑
 *   4. 无论成败都删掉临时目录
 *
 * 用法：
 *   node scripts/test-in-dsh.mjs
 *   node scripts/test-in-dsh.mjs --dsh /path/to/deepseek-harness
 *   node scripts/test-in-dsh.mjs --keep      # 保留临时目录，便于排查
 */

import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function parseArgs(argv) {
  const args = { keep: false }
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i]
    if (key === '--dsh') args.dsh = argv[++i]
    else if (key === '--keep') args.keep = true
    else if (key === '-h' || key === '--help') {
      console.log(`在 DSH workspace 里跑测试

  --dsh <path>  DSH 仓库路径（默认 DSH_HOME 或同级 deepseek-harness）
  --keep        保留临时目录，便于排查`)
      process.exit(0)
    } else throw new Error(`不认识的参数：${key}`)
  }
  return args
}

/** DSH 仓库根：显式参数 > DSH_HOME > 同级目录 */
function findDsh(explicit) {
  const candidates = [
    explicit,
    process.env.DSH_HOME && path.resolve(process.env.DSH_HOME, '..'),
    path.join(repoRoot, '..', 'deepseek-harness'),
  ].filter(Boolean)
  for (const dir of candidates) {
    const manifest = path.join(dir, 'package.json')
    if (!existsSync(manifest)) continue
    const pkg = JSON.parse(readFileSync(manifest, 'utf8'))
    // 只认 DSH 根，不认随便一个带 package.json 的目录
    if (pkg.name === '@deepseek-ai/dsh-root') return dir
  }
  throw new Error(
    `找不到 DSH 仓库（找过：${candidates.join('、')}）。\n` +
      `用 --dsh <path> 指定，或把 DSH_HOME 指到 DSH 安装根。`,
  )
}

const args = parseArgs(process.argv.slice(2))
const dsh = findDsh(args.dsh)
const stage = path.join(dsh, 'packages', 'ci', 'lazy-dispatcher')

const localVitest = path.join(dsh, 'node_modules', '.bin', process.platform === 'win32' ? 'vitest.CMD' : 'vitest')
if (!existsSync(localVitest)) {
  throw new Error(`DSH 里没有 vitest，先装依赖：cd "${dsh}" && pnpm install`)
}

console.log(`DSH:   ${dsh}`)
console.log(`stage: ${stage}`)

rmSync(stage, { recursive: true, force: true })
mkdirSync(path.join(stage, 'tests'), { recursive: true })
mkdirSync(path.join(stage, 'src'), { recursive: true })
cpSync(path.join(repoRoot, 'tests'), path.join(stage, 'tests'), { recursive: true })
cpSync(path.join(repoRoot, 'src'), path.join(stage, 'src'), { recursive: true })
console.log('staged:', readdirSync(path.join(stage, 'tests')).join('、'))

const result = spawnSync(localVitest, ['run', `packages/ci/lazy-dispatcher/tests`], {
  cwd: dsh,
  stdio: 'inherit',
  shell: process.platform === 'win32',
})

if (!args.keep) rmSync(path.join(dsh, 'packages', 'ci'), { recursive: true, force: true })
else console.log(`临时目录保留在 ${stage}`)

process.exit(result.status ?? 1)

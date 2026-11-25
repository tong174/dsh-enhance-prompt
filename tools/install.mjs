#!/usr/bin/env node
/**
 * 把本插件装进（或从）本机 DSH profile。
 *
 *   node tools/install.mjs              # 装：复制到 profile 的 node_modules + 登记依赖与 bundles
 *   node tools/install.mjs --uninstall   # 卸：从 bundles/依赖里摘掉，再删目录
 *   node tools/install.mjs --profile <路径>
 *
 * 为什么不用 pnpm：本机 profile 的 pnpm-lock 会撞 minimum-release-age 策略，
 * 且 dsh-purge 之类的 file: 依赖随时可能把 install 卡死；插件是纯 JS 无依赖，
 * 直接复制目录最稳（与 dsh-purge 的手工同步先例一致）。
 */
import { cpSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const PKG = 'dsh-enhance-prompt'
const here = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const uninstall = argv.includes('--uninstall')
const profileFlag = argv.indexOf('--profile')
const profileDir =
  profileFlag >= 0 && argv[profileFlag + 1]
    ? resolve(argv[profileFlag + 1])
    : join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.dsh', 'profiles', 'desktop')

const pkgPath = join(profileDir, 'package.json')
if (!existsSync(pkgPath)) {
  console.error(`找不到 profile: ${pkgPath}`)
  process.exit(1)
}

const manifest = JSON.parse(readFileSync(pkgPath, 'utf8'))
manifest.dependencies ??= {}
manifest.dsh ??= {}
manifest.dsh.profile ??= {}
manifest.dsh.profile.bundles ??= []
const bundles = manifest.dsh.profile.bundles
const target = join(profileDir, 'node_modules', PKG)

if (uninstall) {
  manifest.dsh.profile.bundles = bundles.filter((name) => name !== PKG)
  delete manifest.dependencies[PKG]
  writeFileSync(pkgPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  rmSync(target, { recursive: true, force: true })
  console.log('已卸载：bundles/依赖已摘除，目录已删除')
  process.exit(0)
}

rmSync(target, { recursive: true, force: true })
cpSync(here, target, {
  recursive: true,
  filter: (src) => !/[\\/](node_modules|\.git)([\\/]|$)/.test(src),
})
manifest.dependencies[PKG] = `file:${here.replace(/\\/g, '/')}`
if (!bundles.includes(PKG)) bundles.push(PKG)
writeFileSync(pkgPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')

console.log(`已安装到 ${target}`)
console.log(`profile 依赖已登记：${manifest.dependencies[PKG]}`)
console.log(`bundles 现有 ${bundles.length} 项，尾部：${bundles.slice(-3).join(', ')}`)
console.log('下一步：刷新窗口（Ctrl+R）看输入框右侧的四角星；bundle 是纯 insert，无需重启 DSH。')

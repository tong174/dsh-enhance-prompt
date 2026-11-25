// 一次性脚本：把 README 的配置表 / 接口前缀 / 验证章节对齐 v0.3.0（幂等）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const file = path.join(root, 'README.md');
let s = fs.readFileSync(file, 'utf8');

const rules = [
  // 配置表
  ['| `maxTokens` | `1200` | 增强结果通常 100~400 token，留够推理模型的 reasoning 余量 |',
   '| `maxTokens` | `4000` | 增强结果通常 100~400 token；推理模型的 reasoning 也吃这个预算，留足 |'],
  ['| `timeoutMs` | `45000` |', '| `timeoutMs` | `60000` |'],
  ['| `provider` / `model` | `\'\'` | 留空 = 自动挑：遍历 `llm.listProviders()` 取第一个有模型的 provider |',
   '| `provider` / `model` | `\'\'` | 留空 = 候选链自动试（见 `providerPriority` / `maxAttempts`） |'],
  ['| `promptStyle` | `workbuddy` | `workbuddy` = 原版 Jr/Yr；`system` = 通用润色提示词（非代码场景） |',
   '| `promptStyle` | `enhanced` | `enhanced` = 优化版（A/B 实测优于原版）；`workbuddy` = 逐字复刻的 Jr/Yr；`system` = 通用润色提示词 |'],
  ['| `toolsEnabled` | `true` | 是否注册 `enhance_prompt` 工具 |',
   '| `toolsEnabled` | `true` | 是否注册 `enhance_prompt` 工具 |\n'
   + '| `providerPriority` | `[]` | 候选 provider 的优先顺序，命中的排前面 |\n'
   + '| `maxAttempts` | `6` | 一次增强最多试几个候选路由（前几个 provider 常常 key 失效/余额不足） |\n'
   + '| `selfTestOnStart` | `true` | 加载后跑一次自检并把结果写进日志（排障用） |\n'
   + '| `logFile` | `~/.dsh/enhance-prompt.log` | 宿主侧文件日志；浏览器侧的失败也会 POST 到这里 |'],
  // 接口
  ['POST /api/enhance-prompt/enhance', 'POST /dsh-enhance-prompt/enhance'],
  ['GET  /api/enhance-prompt/info', 'GET  /dsh-enhance-prompt/info'],
  ['"promptStyle": "workbuddy", "configuredProvider"', '"promptStyle": "enhanced", "configuredProvider"'],
  ['错误码与 WorkBuddy 对齐：',
   '`/api/enhance-prompt/*` 保留为别名，但宿主 api-gateway 会先接管该前缀并回 401，**实际请用 `/dsh-enhance-prompt/*`**。'
   + '另有 `POST /dsh-enhance-prompt/report`（浏览器侧失败上报，写日志）与 `GET /dsh-enhance-prompt/selftest`（真跑一次增强）。\n\n'
   + '错误码与 WorkBuddy 对齐：'],
  // 验证
  ['node test/live.mjs group/deepseek  # 换模型',
   'node test/live.mjs group/deepseek  # 换模型\n\n'
   + '# A/B 质量对比：WorkBuddy 原版 prompt vs 我们的优化版（12 用例 × N 轮裁判）\n'
   + 'node test/compare.mjs --round 6 --passes 5\n'
   + 'node tools/report.mjs              # 由各轮 json 生成 docs/compare-report.md\n\n'
   + '# 线上验证：直接打插件接口，看默认风格的真实输出\n'
   + 'node test/live-compare.mjs'],
];

let changed = 0;
for (const [from, to] of rules) {
  if (!s.includes(from)) continue;
  s = s.replace(from, to);
  changed += 1;
}

fs.writeFileSync(file, s, 'utf8');
console.log(`patched ${changed}/${rules.length} rules`);
for (const [from] of rules) if (s.includes(from)) console.log('MISS:', from.slice(0, 60));

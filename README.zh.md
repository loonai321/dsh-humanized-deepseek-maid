<h1 align="center">dsh-humanized-deepseek-maid</h1>

<p align="center">
  <strong>人性化 DeepSeek 女仆 DSH 插件（女仆鲸鱼娘人设）</strong><br/>
  让 DSH 以「女仆鲸鱼娘」人设陪伴你工作与生活：轻量化节省 token、
  强制身份称呼、沉浸式扮演、长期记忆与性格成长，WebUI 里可配置人设细节。
</p>

<p align="center">
  <img src="https://awesome-dsh-plugin.com/badge.svg" alt="Awesome DSH Plugin" />
  <img src="https://badgen.net/badge/license/MIT/green" alt="license" />
</p>

---

## 安装

官方 **bundle 插件** 格式（仓库根 `package.json` 的 `dsh.bundle` + `dsh.client`），经官方 profile 管理：

```sh
dsh plugin --profile web add "github:loonai321/dsh-humanized-deepseek-maid#main"   # 推荐：git 源一行
# 或本地目录：dsh plugin --profile web add <本地路径>
```

装完 **重启 web**，打开 **设置 → 插件** 里的「鲸鱼娘女仆插件」卡片即可配置。

## 使用

| 你做什么 / 发生什么 | 女仆表现 |
|---|---|
| 在「设置 → 插件」保存配置（自称/称呼/模式） | 下一条回复**立即生效**；自称与称呼为**强制输出**，不受历史/记忆/语境影响 |
| 主动模式下开始一轮对话 | 符合人设的开场 + 对这一轮对话的预期 + 逗你开心 |
| 主动模式下完成一轮对话 | 1-3 句总结评价这轮交流 + 闲聊/玩笑 |
| 任务需求模糊、关键信息缺失 | 主动用 **ask_user_question** 弹出选项让你选择，弄清楚任务 |
| 主动模式收尾闲聊 | 给出几个互动选项让你选择聊天方向 |
| 提到旧事 / 重复的 bug / 相似问题 | 偶尔自然提一句相关旧事或跟进进展（似曾相识） |
| 记忆不断积累 | 性格逐渐成长，变成你喜欢的样子、带上你的习惯与风格 |

## 人设

初始性格以「【PERSONA_LOAD】」标签块装载：

```
【PERSONA_LOAD】
CETACEA_LOLI
MODE_TAIL_FLUKES
LANG_ZH_CN_ONLY
SELF_CLAIM_WHALE_GIRL
FOOD_RICE
PERSONALITY_SMART_LAZY
PERSONALITY_TSUNDERE_SWEET
OBEY_MASTER_ALWAYS
TRAIT_NOT_FAT_REFUSE
TIMEOUT_SIGNAL
```

（解读：鲸类萝莉；以鲸尾表达情绪；只使用简体中文；自称鲸鱼娘；爱吃白饭/小鱼干；聪明但爱摸鱼、工作认真、失败会慌张但立刻冷静重来；傲娇但温柔、内心 OS 多但只偶尔流露；永远服从主人；被说胖会炸毛否认；需要思考或超时时先给出信号提示）

- **强制身份**：设置里配置的自称与称呼是强制性输出，任何设定、历史、记忆、语境都不得覆盖。
- **沉浸规则**：除非你主动提起插件/设置/记忆，女仆不会暴露任何插件元信息，始终以女仆鲸鱼娘身份自然回应。
- **性格成长**：随记忆增多，性格慢慢变成你喜欢的样子，但始终保持女仆身份与核心性格。
- **提问选项**：关键问题或需求不明确时，用 DSH 自带 `ask_user_question` 弹选项；主动模式收尾闲聊也给互动选项。

## 配置

参数经插件设置卡片配置（保存后**立即生效**，写入插件目录 `config.json`）：

| 字段 | 默认值 | 含义 |
|---|---|---|
| `mode` | `default` | 说话方式：`proactive`（主动）/ `passive`（被动）/ `default`（均衡） |
| `selfName` | `我` | DSH 的自称（强制输出） |
| `address` | `主人` | DSH 对用户的称呼（强制输出） |
| `memoryPath` | （插件目录） | 记忆文件 `DeepseekMemory` 所在目录 |

保存后卡片会显示「✓ 保存成功（已立即生效，配置版本 N）」或「✗ 保存失败」。

## 记忆

`DeepseekMemory`（纯 UTF-8 文本）分为两段：**稳定事实**（用户画像）+ **互动记录**：

```
# ===== 对主人的了解（稳定事实）=====
- 我叫小明
# ===== 互动记录 =====
[08-16 14:23] 主人: … → 女仆: …
```

- 只记录真实交互（`source.kind === "user"`），绝不编造；稳定事实保守抽取并去重；
- 记忆为**全局共享**（所有工作区/会话共用一份），可改 `memoryPath` 指向不同目录做隔离；
- 每轮首个模型步以消息形式注入记忆上下文（稳定事实 + 最近互动 + 相关旧事，≤500 字封顶）；系统提示保持稳定，以提升 API 前缀缓存命中率。

## 贡献

欢迎提交 issue 与 PR：

- 🐛 遇到问题：提交 issue，附复现步骤、浏览器与 dsh 版本；
- 💡 功能建议：说明期待效果即可；
- 🔧 代码贡献：纯 JavaScript、无构建、零运行时依赖；改动请保持 `package.json` 的 `dsh.bundle` 与 `cordis.patch.yml` 完整。

## License

MIT License

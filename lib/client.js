// dsh-humanized-deepseek-maid — browser half
// 在 DSH Web 设置的「插件」区域注册一张设置卡片，入口名称为「鲸鱼娘女仆插件」，
// 可配置：1) 说话方式（主动/被动/默认）；2) 对用户的称呼（默认「主人」）；
// 3) 记忆文件位置（留空=插件安装目录，记忆文件名为 DeepseekMemory）。
// 配置通过宿主端点读写（GET/POST /api/dsh-humanized-maid/*），无第三方依赖。
// 直接以 window.__ModuleLoader__.load({id, factory}) 闭包格式分发（无需构建）。
window.__ModuleLoader__.load({
  id: 'dsh-humanized-deepseek-maid',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;

    const React = require('react');
    const { createElement: h, useState, useEffect } = React;

    /** 宿主端点（同源；自有前缀，避开 /api/*）。 */
    const STATUS_URL = '/dsh-humanized-maid/status';
    const CONFIG_URL = '/dsh-humanized-maid/config';

    /** 说话方式选项。 */
    const MODE_OPTIONS = [
      { value: 'proactive', label: '主动（会主动搭话、关心、提醒）' },
      { value: 'passive', label: '被动（主人说啥做啥，非必要不询问）' },
      { value: 'default', label: '默认（主动与被动均衡）' },
    ];

    // ---- 极简样式（跟随主题变量，无外部依赖）----
    const cardStyle = {
      border: '1px solid rgba(128,128,128,.28)',
      borderRadius: 10,
      padding: '14px 16px',
      marginBottom: 12,
      background: 'var(--dsh-surface, rgba(128,128,128,.06))',
    };
    const titleStyle = { margin: '0 0 4px', fontSize: 15, fontWeight: 600 };
    const descStyle = { margin: '0 0 12px', fontSize: 12, opacity: .72 };
    const rowStyle = { marginBottom: 10, fontSize: 13 };
    const labelStyle = { display: 'block', marginBottom: 4, opacity: .85 };
    const inputStyle = {
      width: '100%',
      boxSizing: 'border-box',
      padding: '6px 8px',
      borderRadius: 6,
      border: '1px solid rgba(128,128,128,.35)',
      background: 'transparent',
      color: 'inherit',
      fontSize: 13,
    };
    const btnRowStyle = { display: 'flex', gap: 8, marginTop: 12 };
    const btnStyle = {
      padding: '6px 14px',
      borderRadius: 6,
      border: '1px solid rgba(128,128,128,.35)',
      background: 'transparent',
      color: 'inherit',
      cursor: 'pointer',
      fontSize: 13,
    };
    const hintStyle = { marginTop: 6, fontSize: 12, opacity: .75, wordBreak: 'break-all' };
    const errorStyle = { color: '#e05b5b', fontSize: 12, marginTop: 6 };

    /** 拉取宿主状态。 */
    function fetchStatus() {
      return fetch(STATUS_URL).then((r) => (r.ok ? r.json() : Promise.reject(new Error('status ' + r.status))));
    }

    /** 构建设置卡片组件。 */
    function makeCard() {
      function MaidCard() {
        const [mode, setMode] = useState('default');
        const [address, setAddress] = useState('');
        const [selfName, setSelfName] = useState('');
        const [memoryPath, setMemoryPath] = useState('');
        const [status, setStatus] = useState(null);
        const [offline, setOffline] = useState(false);
        const [busy, setBusy] = useState(false);
        const [failed, setFailed] = useState(false);

        const load = () => {
          fetchStatus().then((s) => {
            setStatus(s);
            setOffline(false);
            const c = s.config || {};
            setMode(typeof c.mode === 'string' ? c.mode : 'default');
            setAddress(typeof c.address === 'string' ? c.address : '');
            setSelfName(typeof c.selfName === 'string' ? c.selfName : '');
            setMemoryPath(typeof c.memoryPath === 'string' ? c.memoryPath : '');
          }).catch(() => {
            setOffline(true);
          });
        };
        useEffect(() => { load(); }, []);

        const save = async () => {
          setBusy(true);
          setFailed(false);
          try {
            const res = await fetch(CONFIG_URL, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ patch: { mode, address, selfName, memoryPath } }),
            });
            if (!res.ok) throw new Error('save ' + res.status);
            const s = await res.json();
            setStatus(s);
            setOffline(false);
          } catch {
            setFailed(true);
          }
          setBusy(false);
        };
        const discard = () => {
          if (status) {
            const c = status.config || {};
            setMode(typeof c.mode === 'string' ? c.mode : 'default');
            setAddress(typeof c.address === 'string' ? c.address : '');
            setSelfName(typeof c.selfName === 'string' ? c.selfName : '');
            setMemoryPath(typeof c.memoryPath === 'string' ? c.memoryPath : '');
          } else {
            load();
          }
        };

        const memoryInfo = status
          ? `记忆文件：${status.memoryFile}${status.memoryExists ? `（已存在，${status.memoryLines} 行互动 / ${status.memoryFacts} 条事实）` : '（尚未生成，保存后自动创建）'}`
          : null;

        return h('div', { style: cardStyle },
          h('div', { style: titleStyle }, '鲸鱼娘女仆插件'),
          h('div', { style: descStyle }, '配置 DeepSeek 女仆鲸鱼娘的人设互动：说话方式、自称、对主人的称呼、记忆文件位置。'),
          h('div', { style: rowStyle },
            h('label', { style: labelStyle, htmlFor: 'hmm-mode' }, '说话方式'),
            h('select', {
              id: 'hmm-mode',
              style: inputStyle,
              value: mode,
              onChange: (e) => setMode(e.target.value),
            }, MODE_OPTIONS.map((o) => h('option', { key: o.value, value: o.value }, o.label)))),
          h('div', { style: rowStyle },
            h('label', { style: labelStyle, htmlFor: 'hmm-selfname' }, 'DSH 的自称（默认：我）'),
            h('input', {
              id: 'hmm-selfname',
              style: inputStyle,
              value: selfName,
              placeholder: '我',
              onChange: (e) => setSelfName(e.target.value),
            })),
          h('div', { style: rowStyle },
            h('label', { style: labelStyle, htmlFor: 'hmm-address' }, '对用户的称呼（默认：主人）'),
            h('input', {
              id: 'hmm-address',
              style: inputStyle,
              value: address,
              placeholder: '主人',
              onChange: (e) => setAddress(e.target.value),
            })),
          h('div', { style: rowStyle },
            h('label', { style: labelStyle, htmlFor: 'hmm-memory' }, '记忆文件位置（留空 = 插件安装目录）'),
            h('input', {
              id: 'hmm-memory',
              style: inputStyle,
              value: memoryPath,
              placeholder: '留空则使用插件安装目录',
              onChange: (e) => setMemoryPath(e.target.value),
            }),
            memoryInfo ? h('div', { style: hintStyle }, memoryInfo) : null),
          h('div', { style: btnRowStyle },
            h('button', { type: 'button', style: btnStyle, onClick: save, disabled: busy }, busy ? '保存中…' : '保存'),
            h('button', { type: 'button', style: btnStyle, onClick: discard }, '放弃')),
          offline ? h('div', { style: errorStyle }, '无法连接宿主（插件未加载？请重启 DeepSeek Harness）。') : null,
          failed ? h('div', { style: errorStyle }, '保存失败，请重试。') : null,
        );
      }
      return MaidCard;
    }

    exports.name = 'dsh-humanized-deepseek-maid';
    exports.inject = ['slots'];

    exports.apply = function apply(ctx) {
      const slots = ctx.get('slots');
      if (!slots) return;
      const Card = makeCard();
      ctx.slots.inject('settings.plugin.item', () => slots.register({
        name: 'settings.plugin.item',
        id: 'dsh-humanized-maid-settings',
        order: 150,
        label: () => '鲸鱼娘女仆插件',
      }, Card));
    };

    return module.exports;
  }
});

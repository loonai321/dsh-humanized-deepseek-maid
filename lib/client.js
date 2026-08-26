// dsh-humanized-deepseek-maid — browser half
// 在 DSH Web 设置的「插件」区域注册一张设置卡片，入口名称为「鲸鱼娘女仆插件」，
// 可配置：1) 说话方式（主动/被动/默认）；2) 对用户的称呼（默认「主人」）；
// 3) 记忆文件位置（留空=插件安装目录，记忆文件名为 DeepseekMemory）。
// 配置通过宿主端点读写（GET/POST /dsh-humanized-maid/*），无第三方依赖。
// 直接以 window.__ModuleLoader__.load({id, factory}) 闭包格式分发（无需构建）。
//
// ## 卡片风格
// 与宿主「插件配置」页的 PluginCard 设计 tokens 逐一镜像（圆角 12px、
// --dsw-alias-* 主题变量、可折叠 header + chevron、field 行 + footer 按钮），
// 类名使用自有 dshm- 前缀并通过注入 <style> 提供，不依赖宿主内部类名。
window.__ModuleLoader__.load({
  id: 'dsh-humanized-deepseek-maid',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;

    const React = require('react');
    const { createElement: h, useState, useEffect } = React;

    // ---- 卡片样式：镜像宿主 PluginCard / ValueField 的设计 tokens（--dsw-alias-*）----
    const CSS_ID = 'dsh-humanized-deepseek-maid/settings-card.css';
    const CSS_TEXT = [
      '.dshm-card{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);border-radius:12px;list-style:none;transition:border-color .16s,background .16s}',
      '.dshm-card:hover{border-color:var(--dsw-alias-label-dimmed)}',
      '.dshm-cardOpen{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-label-dimmed)}',
      '.dshm-header{appearance:none;width:100%;font:inherit;color:inherit;text-align:left;cursor:pointer;background:0 0;border:0;border-radius:12px;align-items:center;gap:12px;padding:14px 16px;display:flex}',
      '.dshm-header:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}',
      '.dshm-headText{flex-direction:column;flex:1;gap:4px;min-width:0;display:flex}',
      '.dshm-name{color:var(--dsw-alias-label-primary);font-size:15px;font-weight:600;line-height:1.4}',
      '.dshm-description{color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:1.5}',
      '.dshm-pending{white-space:nowrap;background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-secondary);border-radius:999px;flex:none;padding:1px 8px;font-size:11px;font-weight:500;line-height:17px}',
      '.dshm-chevron{color:var(--dsw-alias-label-tertiary);flex:none;transition:transform .16s}',
      '.dshm-chevronOpen{transform:rotate(180deg)}',
      '.dshm-body{border-top:1px solid var(--dsw-alias-border-l2);margin:0 16px;padding-bottom:8px}',
      '.dshm-field{flex-direction:column;gap:6px;padding:12px 0;display:flex}',
      '.dshm-field+.dshm-field{border-top:1px solid var(--dsw-alias-border-l2)}',
      '.dshm-head{align-items:center;gap:8px;display:flex}',
      '.dshm-label{min-width:0;color:var(--dsw-alias-label-primary);flex:1;font-size:13px;font-weight:500;line-height:1.5}',
      '.dshm-input{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);height:34px;font:inherit;color:var(--dsw-alias-label-primary);border-radius:8px;padding:0 12px;font-size:13px;line-height:1.5}',
      '.dshm-input:focus-visible{border-color:var(--dsw-alias-brand-primary);outline:none}',
      '.dshm-input:disabled{color:var(--dsw-alias-label-tertiary);cursor:default}',
      '.dshm-hint{color:var(--dsw-alias-label-tertiary);margin:0;font-size:12px;line-height:1.5}',
      '.dshm-footer{border-top:1px solid var(--dsw-alias-border-l2);justify-content:flex-end;align-items:center;gap:8px;padding:12px 0 4px;display:flex}',
      '.dshm-status{min-width:0;flex:1;margin:0;font-size:12px;line-height:1.5}',
      '.dshm-failed{color:var(--dsw-alias-label-error)}',
      '.dshm-ok{color:var(--dsw-alias-label-tertiary)}',
      '.dshm-discard,.dshm-save{appearance:none;font:inherit;cursor:pointer;border:1px solid #0000;border-radius:8px;padding:5px 14px;font-size:13px;line-height:1.5}',
      '.dshm-discard{border-color:var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);background:0 0}',
      '.dshm-discard:hover:not(:disabled){color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-label-dimmed)}',
      '.dshm-save{background:var(--dsw-alias-label-primary);color:var(--dsw-alias-bg-layer-3)}',
      '.dshm-discard:disabled,.dshm-save:disabled{opacity:.4;cursor:default}',
      '.dshm-discard:focus-visible,.dshm-save:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}',
    ].join('');
    if (typeof document !== 'undefined' && document.querySelector('style[data-plugin-css="' + CSS_ID + '"]') === null) {
      const tag = document.createElement('style');
      tag.dataset.plugin = 'dsh-humanized-deepseek-maid';
      tag.dataset.pluginCss = CSS_ID;
      tag.textContent = CSS_TEXT;
      document.head.appendChild(tag);
    }

    /** 宿主端点（同源；自有前缀，避开 /api/*）。 */
    const STATUS_URL = '/dsh-humanized-maid/status';
    const CONFIG_URL = '/dsh-humanized-maid/config';

    /** 说话方式选项。 */
    const MODE_OPTIONS = [
      { value: 'proactive', label: '主动（会主动搭话、关心、提醒）' },
      { value: 'passive', label: '被动（主人说啥做啥，非必要不询问）' },
      { value: 'default', label: '默认（主动与被动均衡）' },
    ];

    /** chevron 图标（内联 outline 箭头，颜色跟随 currentColor，形状对齐宿主 14px 图标）。 */
    const chevronIcon = h('svg', {
      width: 14,
      height: 14,
      viewBox: '0 0 14 14',
      fill: 'none',
      'aria-hidden': true,
    }, h('path', {
      d: 'M3.5 5.5 7 9l3.5-3.5',
      stroke: 'currentColor',
      strokeWidth: 1.5,
      strokeLinecap: 'round',
      strokeLinejoin: 'round',
    }));

    /** 拉取宿主状态。 */
    function fetchStatus() {
      return fetch(STATUS_URL).then((r) => (r.ok ? r.json() : Promise.reject(new Error('status ' + r.status))));
    }

    /** 从状态对象提取配置快照（用于脏检测）。 */
    function configOf(status) {
      const c = (status && status.config) || {};
      return {
        mode: typeof c.mode === 'string' ? c.mode : 'default',
        address: typeof c.address === 'string' ? c.address : '',
        selfName: typeof c.selfName === 'string' ? c.selfName : '',
        memoryPath: typeof c.memoryPath === 'string' ? c.memoryPath : '',
      };
    }

    /** 一行字段（label + 控件 + hint），对齐宿主 ValueField 布局。 */
    function field(label, control, hint) {
      return h('div', { className: 'dshm-field' },
        h('div', { className: 'dshm-head' },
          h('label', { className: 'dshm-label', htmlFor: control.props.id }, label)),
        control,
        hint ? h('p', { className: 'dshm-hint' }, hint) : null);
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
        const [saved, setSaved] = useState(false);
        const [failed, setFailed] = useState(false);
        const [open, setOpen] = useState(false);
        /** 最近一次加载/保存的配置快照；与当前编辑值不同即视为「未保存」。 */
        const [loaded, setLoaded] = useState(null);

        const dirty = loaded !== null && (
          loaded.mode !== mode ||
          loaded.address !== address ||
          loaded.selfName !== selfName ||
          loaded.memoryPath !== memoryPath
        );

        const load = () => {
          fetchStatus().then((s) => {
            setStatus(s);
            setOffline(false);
            const c = configOf(s);
            setMode(c.mode);
            setAddress(c.address);
            setSelfName(c.selfName);
            setMemoryPath(c.memoryPath);
            setLoaded(c);
          }).catch(() => {
            setOffline(true);
          });
        };
        useEffect(() => { load(); }, []);

        const save = async () => {
          setBusy(true);
          setFailed(false);
          setSaved(false);
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
            setLoaded(configOf(s));
            setSaved(true);
            window.setTimeout(() => setSaved(false), 3500);
          } catch {
            setFailed(true);
          }
          setBusy(false);
        };
        const discard = () => {
          if (status) {
            const c = configOf(status);
            setMode(c.mode);
            setAddress(c.address);
            setSelfName(c.selfName);
            setMemoryPath(c.memoryPath);
            setLoaded(c);
          } else {
            load();
          }
        };

        const memoryInfo = status
          ? `记忆文件：${status.memoryFile}${status.memoryExists ? `（已存在，${status.memoryLines} 行互动 / ${status.memoryFacts} 条事实）` : '（尚未生成，保存后自动创建）'}`
          : null;

        const statusText = saved
          ? '✓ 保存成功（已立即生效' + (status && typeof status.configRevision === 'number' ? '，配置版本 ' + status.configRevision : '') + '）'
          : failed
            ? '✗ 保存失败，请重试。'
            : offline
              ? '无法连接宿主（插件未加载？请重启 DeepSeek Harness）。'
              : null;

        return h('li', { className: 'dshm-card' + (open ? ' dshm-cardOpen' : '') },
          h('button', {
            type: 'button',
            className: 'dshm-header',
            'aria-expanded': open,
            'aria-label': (open ? '收起' : '展开') + '鲸鱼娘女仆插件设置',
            onClick: () => { setOpen(!open); },
          },
            h('span', { className: 'dshm-headText' },
              h('span', { className: 'dshm-name' }, '鲸鱼娘女仆插件'),
              h('span', { className: 'dshm-description' }, '配置 DeepSeek 女仆鲸鱼娘的人设互动：说话方式、自称、对主人的称呼、记忆文件位置。')),
            dirty ? h('span', { className: 'dshm-pending' }, '未保存') : null,
            h('span', { className: 'dshm-chevron' + (open ? ' dshm-chevronOpen' : '') }, chevronIcon)),
          open ? h('div', { className: 'dshm-body' },
            field('说话方式',
              h('select', {
                id: 'hmm-mode',
                className: 'dshm-input',
                value: mode,
                onChange: (e) => setMode(e.target.value),
              }, MODE_OPTIONS.map((o) => h('option', { key: o.value, value: o.value }, o.label))),
              '主动：会主动搭话、关心、提醒；被动：非必要不询问；默认：主动与被动均衡'),
            field('DSH 的自称（默认：我）',
              h('input', {
                id: 'hmm-selfname',
                className: 'dshm-input',
                value: selfName,
                placeholder: '我',
                onChange: (e) => setSelfName(e.target.value),
              }),
              null),
            field('对用户的称呼（默认：主人）',
              h('input', {
                id: 'hmm-address',
                className: 'dshm-input',
                value: address,
                placeholder: '主人',
                onChange: (e) => setAddress(e.target.value),
              }),
              null),
            field('记忆文件位置（留空 = 插件安装目录）',
              h('input', {
                id: 'hmm-memory',
                className: 'dshm-input',
                value: memoryPath,
                placeholder: '留空则使用插件安装目录',
                onChange: (e) => setMemoryPath(e.target.value),
              }),
              memoryInfo),
            h('div', { className: 'dshm-footer' },
              statusText ? h('p', { className: 'dshm-status ' + (failed || offline ? 'dshm-failed' : 'dshm-ok'), role: 'status' }, statusText) : null,
              h('button', {
                type: 'button',
                className: 'dshm-discard',
                disabled: !dirty || busy,
                onClick: discard,
              }, '放弃'),
              h('button', {
                type: 'button',
                className: 'dshm-save',
                disabled: !dirty || busy,
                onClick: save,
              }, busy ? '保存中…' : '保存')),
          ) : null,
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
        key: 'dsh-humanized-maid',
        id: 'dsh-humanized-maid-settings',
        order: 150,
        label: () => '鲸鱼娘女仆插件',
      }, Card));
    };

    return module.exports;
  }
});

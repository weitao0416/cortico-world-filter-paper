/**
 * 滤纸 · 说明面板（浏览器端，纯 ES 模块，无构建步骤）
 * 导出 { panels: { about: { mount(ctx) } } }
 */

const ZH = {
  title: '这个插件做什么',
  intro: '交接笔记里，工具调用的机器日志不进去。',
  why: '她的上下文塞满时会写一份交接笔记留给下一轮。那份笔记每次载入都要付钱，而原版把工具参数全文、回执全文一起抄了进去——那是运行日志，不是记忆。',
  howTitle: '它是怎么做的',
  how: [
    '工具入参只留开头 60 字（文件名、地址都在开头，正文丢掉）',
    '成功回执换成「(完成)」；只读类留开头 120 字',
    '失败回执保留「失败：」加开头 90 字，原因不会被当成噪音抹掉',
  ],
  scopeTitle: '它不碰什么',
  scope: '不动机器人设、不动使用者档案、不动用户说的话、不动事件正文。它做的是筛选，不生成新句子——所以不会编造她的记忆。',
  statusTitle: '当前状态',
  patched: '补丁',
  patchedOn: '已生效',
  patchedOff: '未生效',
  handoffs: '已筛交接',
  budget: '笔记上限',
  root: '定位到的程序目录',
  rules: '过滤阈值',
  fail: '读不到状态',
};

const EN = {
  title: 'What this does',
  intro: 'Machine logs from tool calls stay out of the handoff note.',
  why: 'When her context fills, a handoff note is written for the next stretch, and it is paid for on every load. The stock writer copied every tool argument and receipt into it — runtime logs, not memory.',
  howTitle: 'How it works',
  how: [
    'Arguments clipped to 60 chars (paths and URLs sit at the front)',
    'Successful receipts become "(done)"; read-only ones keep 120 chars',
    'Failed receipts keep "failed:" plus 90 chars, so reasons survive',
  ],
  scopeTitle: 'What it leaves alone',
  scope: 'Persona, partner notes, user messages and event text are untouched. It filters; it does not write new sentences, so it cannot invent a memory.',
  statusTitle: 'Status',
  patched: 'Patch',
  patchedOn: 'active',
  patchedOff: 'not applied',
  handoffs: 'Handoffs',
  budget: 'Budget',
  root: 'Detected app root',
  rules: 'Thresholds',
  fail: 'status unavailable',
};

const pick = (language) => (language === 'en' ? EN : ZH);

function line(ui, label, value) {
  const row = ui.h('div', 'row');
  row.append(ui.h('span', 'k', label), ui.h('span', 'v', String(value)));
  return row;
}

export default {
  panels: {
    about: {
      async mount(ctx) {
        const t = pick(ctx.language);
        const { ui, root } = ctx;

        root.append(ui.section(t.title, t.intro));

        const p = ui.h('p', 'note', t.why);
        root.append(p);

        root.append(ui.section(t.howTitle));
        const ul = ui.h('ul', 'rules');
        for (const item of t.how) ul.append(ui.h('li', null, item));
        root.append(ul);

        root.append(ui.section(t.scopeTitle, t.scope));

        const head = ui.section(t.statusTitle);
        const box = ui.h('div', 'status');
        head.append(box);
        root.append(head);

        const paint = (s) => {
          box.replaceChildren(
            line(ui, t.patched, s.patched ? t.patchedOn : `${t.patchedOff}（${s.reason}）`),
            line(ui, t.handoffs, s.handoffs),
            line(ui, t.budget, s.lastBudget || '—'),
            line(ui, t.root, s.corticoRoot || '—'),
            line(ui, t.rules, `arg ${s.rules.ARG_CHARS} / read ${s.rules.READ_CHARS} / fail ${s.rules.FAIL_CHARS}`),
          );
        };

        const refresh = async () => {
          try {
            const out = await ctx.invoke('read');
            paint(out.status ?? {});
          } catch (err) {
            box.replaceChildren(ui.h('p', 'err', `${t.fail}：${err?.message ?? err}`));
          }
        };

        await refresh();
        // 面板开着时每 10 秒刷新一次读数；unmount 会自动停
        ctx.interval(() => { void refresh(); }, 10_000);
      },
    },
  },
};

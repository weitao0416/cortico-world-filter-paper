/**
 * 滤纸 · World 版（桌面版唯一能挂上的位置）
 *
 * 桌面版（Electron）把 bot 写死成内置 cormini，deployment.json 的 bot 字段它不看，
 * 所以 bot 类扩展永远是 idle。但桌面版照样会加载 World 类扩展，而 World 模块是在
 * createBot 之前被 import 的——所以在这里改 Cormini.prototype.onHandoff，
 * 能抢在所有 persona 实例（含桌面版派生的 CoopanionPersona 子类）构造之前生效。
 *
 * 只做一件事：交接笔记里，机器日志不进去。失败原因照旧保留。
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

function findCorticoRoot() {
  const fromEnv = (process.env.COOPANION_CORTICO_ROOT ?? '').trim();
  if (fromEnv) return fromEnv;

  /** 这个目录是不是 cortico 根（含 bots/cormini/persona/persona.ts）。 */
  const isRoot = (dir) => {
    try {
      return existsSync(resolve(dir, 'bots', 'cormini', 'persona', 'persona.ts'));
    } catch {
      return false;
    }
  };

  /** 从某个文件/目录一路向上找，顺带试 `<dir>/build/cortico`（Electron 的 app 根）。 */
  const walkUp = (start) => {
    let dir = start;
    for (let i = 0; i < 8; i += 1) {
      if (isRoot(dir)) return dir;
      if (isRoot(resolve(dir, 'build', 'cortico'))) return resolve(dir, 'build', 'cortico');
      const up = resolve(dir, '..');
      if (up === dir) break;
      dir = up;
    }
    return null;
  };

  // 扩展装成 junction 时，import.meta.dirname 是包的**真实**路径，别处无 bots/cormini。
  // 可靠锚点是核心进程自己的入口：<app>/core/boot.ts。
  const anchors = [];
  const entry = process.argv[1];
  if (entry) anchors.push(dirname(resolve(entry)));
  anchors.push(process.cwd(), import.meta.dirname);

  for (const anchor of anchors) {
    const found = walkUp(anchor);
    if (found) return found;
  }
  return null;
}

export const CORTICO_ROOT = findCorticoRoot();
const CORMINI = CORTICO_ROOT ? resolve(CORTICO_ROOT, 'bots', 'cormini') : null;

/** 供自检读的状态。 */
export const state = { patched: false, reason: '', handoffs: 0, lastBudget: 0 };

// ── 过滤规则（要改口味改这里） ──────────────────────────────
const READ_TOOLS = new Set(['read_file', 'list_files', 'glob_files', 'grep_files']);
const FAIL_RE = /错误|失败|不存在|超时|拒绝|error|fail|ENOENT|denied|timeout|traceback/i;
const ARG_CHARS = 60;
const READ_CHARS = 120;
const FAIL_CHARS = 90;

function clip(text, limit) {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim();
  return flat.length <= limit ? flat : `${flat.slice(0, limit)}…`;
}

function outputOf(record) {
  const out = record?.item?.output;
  if (typeof out === 'string') return out;
  if (Array.isArray(out)) return out.map((p) => p?.text ?? '').join('');
  if (out && typeof out === 'object') return JSON.stringify(out);
  return String(out ?? '');
}

function slimRecord(record) {
  const item = record?.item;
  if (!item) return record;
  if (item.type === 'function_call') {
    return { ...record, item: { ...item, arguments: clip(item.arguments ?? '', ARG_CHARS) } };
  }
  if (item.type === 'function_call_output') {
    const text = outputOf(record);
    const output = FAIL_RE.test(text) ? `失败：${clip(text, FAIL_CHARS)}`
      : READ_TOOLS.has(item.name) ? clip(text, READ_CHARS)
      : '(完成)';
    return { ...record, item: { ...item, output } };
  }
  return record;
}

export function filterSnapshot(snapshot) {
  return Array.isArray(snapshot) ? snapshot.map(slimRecord) : snapshot;
}

// ── 打补丁（import 时就做，早于任何 persona 实例） ─────────────
const MARK = '[system] 这份笔记过了滤纸：工具调用只留名字和开头，回执只留结论，失败原因照旧保留。';

async function patch() {
  if (!CORMINI) {
    state.reason = '找不到 Coopanion 的 build/cortico（补丁未打，行为与原来一致）';
    console.warn('[filter-paper] ' + state.reason);
    return;
  }
  let personaMod;
  let noteMod;
  try {
    personaMod = await import(pathToFileURL(resolve(CORMINI, 'persona', 'persona.ts')).href);
    noteMod = await import(pathToFileURL(resolve(CORMINI, 'persona', 'handoffNote.ts')).href);
  } catch (err) {
    state.reason = `加载 cormini 失败：${err?.message ?? err}`;
    console.warn('[filter-paper] ' + state.reason);
    return;
  }

  const { Cormini, HANDOFF_DIR } = personaMod;
  const { HANDOFF_NOTE_TYPE, handoffNoteStamp, renderHandoffNote } = noteMod;

  if (!Cormini?.prototype) {
    state.reason = '拿不到 Cormini';
    console.warn('[filter-paper] ' + state.reason);
    return;
  }
  if (Cormini.prototype.__filterPaper) {
    state.patched = true;
    state.reason = '已经打过补丁';
    return;
  }
  if (typeof Cormini.prototype.onHandoff !== 'function' || typeof renderHandoffNote !== 'function') {
    state.reason = '新版结构对不上，放弃打补丁（原版行为不变）';
    console.warn('[filter-paper] ' + state.reason);
    return;
  }

  const original = Cormini.prototype.onHandoff;

  Cormini.prototype.onHandoff = async function filterPaperHandoff(snapshot, ctx) {
    try {
      const tagged = (tag) => this.core?.toolsTagged?.(tag) ?? new Set();
      const now = new Date();
      const { maxTokens = 0, keepRatio = 0 } = this.context?.() ?? {};
      const wanted = Number(process.env.HANDOFF_FILTER_TOKENS ?? '');
      const budgetTokens = Number.isFinite(wanted) && wanted > 0
        ? Math.floor(wanted)
        : Math.min(Math.floor(maxTokens * keepRatio), 6400);

      const note = renderHandoffNote(filterSnapshot(snapshot), {
        speechTools: tagged('speak'),
        flowTools: tagged('flow'),
        snapshotTools: tagged('snapshot'),
        now,
        budgetTokens,
        splitAtMs: this.pressureSplitAt,
      });

      const file = `${HANDOFF_DIR}${handoffNoteStamp(now)}.md`;
      const abs = join(this.memoryDir, file);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, note.text, 'utf8');
      this.lastHandoffFile = file;
      this.pressureWarned = false;
      this.pressureSplitAt = null;
      this.core?.injectInternal?.(`${this.handoffNote()}\n${MARK}`, 'handoff');
      for (const part of note.parts ?? []) this.core?.injectExternal?.(part.text, HANDOFF_NOTE_TYPE);

      state.handoffs += 1;
      state.lastBudget = budgetTokens;
      return { tail: this.handoffTail ? this.handoffTail(snapshot) : [] };
    } catch (err) {
      console.warn('[filter-paper] 过滤失败，退回原版：', err?.message ?? err);
      return original.call(this, snapshot, ctx);
    }
  };

  Cormini.prototype.__filterPaper = true;
  state.patched = true;
  state.reason = 'ok';
  // 落进 core.log，方便一眼确认这一版真的挂上了
  console.log(`[filter-paper] 补丁已生效（cortico 根：${CORTICO_ROOT}）`);
}

await patch();

// ── 说明文字（面板与状态灯都用它） ────────────────────────────
const ABOUT_ZH = [
  '这个插件做一件事：交接笔记里，工具调用的机器日志不进去。',
  '',
  '她的上下文塞满时会写一份交接笔记留给下一轮，那份笔记每次启动都要整份载入、每次都要付钱。',
  '原版会把工具调用的参数全文、回执全文一起抄进去——那是运行日志，不是记忆。',
  '',
  '滤纸在交接那一刻把 snapshot 里的工具记录压扁，再交给原版渲染器：',
  '· 工具入参只留开头 60 字（文件名、地址都在开头，正文丢掉）',
  '· 成功回执换成「(完成)」；只读类留开头 120 字',
  '· 失败回执保留「失败：」加开头 90 字，原因不会被当成噪音抹掉',
  '',
  '不动机器人设、不动使用者档案、不动用户说的话、不动事件正文。它是筛子，不是摘要器——不生成新句子。',
  '',
  '实测：一次交接从 ≈13,000 token 降到 ≈2,200 token。',
].join('\n');

const ABOUT_EN = [
  'This plugin does one thing: machine logs from tool calls stay out of the handoff note.',
  '',
  'When her context fills, the app writes a handoff note for the next stretch, and that note is loaded in full every round.',
  'The stock writer copies every tool argument and receipt into it — runtime logs, not memory.',
  '',
  'Filter Paper flattens the tool records in the snapshot before the stock renderer sees them:',
  '· arguments clipped to 60 chars (paths and URLs live at the front)',
  '· successful receipts become "(done)"; read-only ones keep 120 chars',
  '· failed receipts keep "failed:" plus 90 chars, so the reason survives',
  '',
  'Persona, partner notes, user messages and event text are untouched. It is a sieve, not a summarizer.',
  '',
  'Measured: one handoff went from ~13,000 tokens to ~2,200.',
].join('\n');

const pick = (language) => (language === 'en' ? ABOUT_EN : ABOUT_ZH);

function statusSnapshot() {
  return {
    patched: state.patched,
    reason: state.reason,
    corticoRoot: CORTICO_ROOT,
    handoffs: state.handoffs,
    lastBudget: state.lastBudget,
    rules: { ARG_CHARS, READ_CHARS, FAIL_CHARS, readTools: [...READ_TOOLS] },
    env: { HANDOFF_FILTER_TOKENS: process.env.HANDOFF_FILTER_TOKENS ?? null },
  };
}

// ── World 外壳：为了被加载 + 提供说明与状态灯 ──────────────────
export default {
  id: 'filter-paper',
  label: '滤纸',
  defaults: () => ({ enabled: true }),
  create: () => ({
    id: 'filter-paper',
    envPromptVars: () => null,
    tools: () => [],
    start: async () => {
      if (!state.patched) console.warn(`[filter-paper] 本轮没有打上补丁：${state.reason}`);
    },
    stop: async () => {},
    webUi: (language) => ({
      label: language === 'en' ? 'Filter Paper' : '滤纸',
      // 导航上的状态灯：一眼看出补丁在不在
      lamps: [{
        label: language === 'en' ? 'Patch' : '补丁',
        state: state.patched ? 'online' : 'error',
        hint: state.patched
          ? (language === 'en' ? 'active; handoff notes are filtered' : `已生效；已筛 ${state.handoffs} 次交接`)
          : (language === 'en' ? `not applied: ${state.reason}` : `未生效：${state.reason}`),
      }],
      badges: [
        { label: language === 'en' ? 'Handoffs' : '已筛交接', value: state.handoffs },
        { label: language === 'en' ? 'Budget' : '笔记上限', value: state.lastBudget || '—' },
      ],
      panels: [{
        id: 'about',
        title: language === 'en' ? 'What this does' : '这个插件做什么',
        description: language === 'en'
          ? 'Handoff notes keep conclusions, drop machine logs. Click to read the rules and live status.'
          : '交接笔记只留结论、机器日志不进去。点开看规则与当前状态。',
        getMethods: ['read'],
      }],
      invoke: async (panel, method) => {
        if (panel !== 'about') return { error: 'no such panel' };
        if (method === 'read' || method === 'state') return { about: pick(language), status: statusSnapshot() };
        return { error: 'no such method' };
      },
    }),
  }),
};

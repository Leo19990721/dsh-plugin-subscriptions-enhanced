import assert from 'node:assert/strict';
import test from 'node:test';
import { agyProgress } from '../src/agy-local-progress.js';

const answer = (progress, value) => progress.push({ kind: 'text', value });

function settled(parts) {
  const progress = agyProgress();
  const frames = parts.flatMap(part => answer(progress, part)).concat(progress.close());
  assert.equal(progress.hasAnswer, parts.join('').trim() !== '');
  assert.deepEqual(frames.filter(frame => frame.type === 'block-start'), [{ type: 'block-start', index: 0, blockType: 'text' }]);
  const text = frames.filter(frame => frame.type === 'text-delta').map(frame => frame.text).join('');
  assert.deepEqual(frames.at(-1), { type: 'block-end', index: 0, block: { type: 'text', text } });
  return text;
}

function atEverySplit(raw, expected = raw) {
  assert.equal(settled([raw]), expected);
  for (let i = 1; i < raw.length; i++) assert.equal(settled([raw.slice(0, i), raw.slice(i)]), expected, `split at ${i}`);
  assert.equal(settled(raw.split('')), expected, 'one UTF-16 code unit per chunk');
}

test('emits native absolute Markdown destinations, preserving label and line ranges', () => {
  atEverySplit('打开 [`文档`](file:///C:/项目 资料/试验😀.md#L24-L30)，与 [代码](file://d:/src/a.ts:5-8)。',
    '打开 [`文档`](C:/项目%20资料/试验😀.md#L24-L30)，与 [代码](d:/src/a.ts:5-8)。');
  atEverySplit('[报告]( <FiLe://D:/有 空格/一(二).docx#L4> "打开 报告" )',
    '[报告]( <D:/有%20空格/一(二).docx#L4> "打开 报告" )');
  atEverySplit('[a](file:///C:/dir/a(b).txt) [b](file://C:/dir/a\\(b\\).txt "title")',
    '[a](C:/dir/a(b).txt) [b](C:/dir/a\\(b\\).txt "title")');
});

test('keeps valid percent escapes for the native one-time decode', () => {
  atEverySplit('[x](file:///C:/My%20Files/%E4%B8%AD%E6%96%87%2520%23%283%29.md#L2-L4)',
    '[x](C:/My%20Files/%E4%B8%AD%E6%96%87%2520%23%283%29.md#L2-L4)');
  atEverySplit('[bad](file:///C:/a%XX) [truncated](file:///C:/a%E4%B8) [control](file:///C:/a%00) [query](file://C:/a.md?raw=1)');
});

test('preserves ordinary URLs, non-drive file references, images and escaped examples', () => {
  atEverySplit('https://example.com/file:///C:/path [web](https://example.com/a(b)?p=file:///C:/path "[x](file:///C:/a)")\n'
    + '[UNC](file://server/share/doc.md) [Unix](file:///tmp/doc.md) [native](C:/dir/doc.md) [web](mailto:x@a.test)\n'
    + '![image](file:///C:/image.png) \\[escaped](file:///C:/demo.md) [literal text](file:///C:/no-close');
});

test('preserves fenced and inline code, resuming normalization after closing delimiters', () => {
  const code = '```markdown\r\n[x](file:///C:/a)\r\n```\r\n'
    + '  ~~~~md\n[x](file://C:/b)\n~~~\n[x](file://C:/b)\n  ~~~~  \n'
    + '> ```md\n> [x](file:///C:/quoted)\n> ```\n'
    + 'Inline `[x](file:///C:/c)` and `` `[x](file://C:/d)` ``.\n';
  atEverySplit(`${code}[yes](file://C:/open.md)`, `${code}[yes](C:/open.md)`);
});

test('streams ordinary prose and publishes only complete link destinations', () => {
  const progress = agyProgress();
  assert.deepEqual(answer(progress, '先看 '), [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text: '先看 ' },
  ]);
  assert.deepEqual(answer(progress, '[结果](fi'), [{ type: 'text-delta', index: 0, text: '[结果]' }]);
  assert.deepEqual(answer(progress, 'le:///C:/中文%2'), []);
  assert.deepEqual(answer(progress, '0页面.md#L1-L2) 后续'), [{ type: 'text-delta', index: 0, text: '(C:/中文%20页面.md#L1-L2) 后续' }]);
  assert.deepEqual(progress.close(), [{ type: 'block-end', index: 0, block: { type: 'text', text: '先看 [结果](C:/中文%20页面.md#L1-L2) 后续' } }]);
});

test('flushes unresolved text at native block boundaries without changing thought or tool progress', () => {
  const progress = agyProgress();
  const raw = '[x](file:///C:/a';
  answer(progress, raw);
  const thought = '[thought](file:///C:/b)';
  assert.deepEqual(progress.push({ kind: 'thought', value: thought }), [
    { type: 'text-delta', index: 0, text: '(file:///C:/a' },
    { type: 'block-end', index: 0, block: { type: 'text', text: raw } },
    { type: 'block-start', index: 1, blockType: 'reasoning' },
    { type: 'reasoning-delta', index: 1, text: thought },
  ]);
  const frames = progress.push({ kind: 'tool', value: { toolCallId: 'read', title: 'Read file:///C:/b', status: 'completed' } });
  assert.equal(frames[0].block.text, thought);
  assert.equal(frames.at(-1).text, '工具已完成：Read file:///C:/b\n\n');
  answer(progress, ') [x](file://C:/b)');
  assert.equal(progress.close().at(-1).block.text, ') [x](C:/b)');
  assert.deepEqual(progress.close(), []);
});

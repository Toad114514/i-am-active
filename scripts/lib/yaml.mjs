/**
 * 极简 YAML 子集解析器（零依赖，仅供 config.yaml 使用）。
 *
 * 支持：
 *  - 缩进嵌套的映射（`key: value`）
 *  - 标量序列（`- value`）
 *  - 内联数组 `[a, b, c]`
 *  - 单/双引号字符串、布尔、整数/小数、null/~
 *  - 整行注释与行尾注释（` # ...`，引号内的 # 不会被当注释）
 *
 * 故意不支持：锚点/别名、块标量（| >）、块映射流式写法 {a: b}、多文档 ---。
 * 遇到不支持的写法会抛错并给出行号，而不是静默解析成奇怪的结构。
 */

class YamlError extends Error {
  constructor(message, file, line) {
    super(`${file}${line ? `:${line}` : ''}: ${message}`);
    this.name = 'YamlError';
    this.line = line;
  }
}

const fail = (file, row, message) => {
  throw new YamlError(message, file, row?.no);
};

/** 去掉行尾注释：只有「前面是空白」的 # 才算注释，引号内的不算。 */
function stripComment(text) {
  let quote = null;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quote) {
      if (ch === quote) {
        if (quote === '"' && text[i - 1] === '\\') continue;
        quote = null;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === '#' && (i === 0 || /\s/.test(text[i - 1]))) return text.slice(0, i);
  }
  return text;
}

/** 行 → { indent, content, no }。空行、注释行、tab 缩进都在这里处理。 */
function tokenize(text, file) {
  const rows = [];
  text.split(/\r?\n/).forEach((line, index) => {
    if (!line.trim()) return;
    if (/^\s*#/.test(line)) return;
    const lead = line.match(/^[ \t]*/)[0];
    if (lead.includes('\t')) fail(file, { no: index + 1 }, '缩进只能用空格，不能用 tab');
    const content = stripComment(line.slice(lead.length)).replace(/\s+$/, '');
    if (!content) return;
    rows.push({ indent: lead.length, content, no: index + 1 });
  });
  return rows;
}

/** 取出 `key:` 的冒号位置（冒号后必须是空格或行尾，且不在引号内）。 */
function keyColon(content) {
  let quote = null;
  for (let i = 0; i < content.length; i += 1) {
    const ch = content[i];
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === ':' && (i === content.length - 1 || content[i + 1] === ' ')) return i;
  }
  return -1;
}

function unquote(text) {
  if (text.length >= 2 && text.startsWith('"') && text.endsWith('"')) {
    return text
      .slice(1, -1)
      .replace(/\\n/g, '\n')
      .replace(/\\t/g, '\t')
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, '\\');
  }
  if (text.length >= 2 && text.startsWith("'") && text.endsWith("'")) {
    return text.slice(1, -1).replace(/''/g, "'");
  }
  return null;
}

/** 按逗号切内联数组，引号内的逗号不切。 */
function splitInline(body) {
  const out = [];
  let buf = '';
  let quote = null;
  for (const ch of body) {
    if (quote) {
      buf += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      buf += ch;
      continue;
    }
    if (ch === ',') {
      out.push(buf);
      buf = '';
      continue;
    }
    buf += ch;
  }
  out.push(buf);
  return out.map((s) => s.trim()).filter((s) => s !== '');
}

function parseScalar(text, file, row) {
  const raw = text.trim();
  if (!raw) return null;
  if (raw.startsWith('[')) {
    if (!raw.endsWith(']')) fail(file, row, `内联数组缺少收尾的 ]：${raw}`);
    return splitInline(raw.slice(1, -1)).map((part) => parseScalar(part, file, row));
  }
  if (raw === '{}') return {};
  const quoted = unquote(raw);
  if (quoted !== null) return quoted;
  if (/^(true|True|TRUE)$/.test(raw)) return true;
  if (/^(false|False|FALSE)$/.test(raw)) return false;
  if (/^(null|Null|NULL|~)$/.test(raw)) return null;
  // 超过 2^53 的整数转 Number 会静默改掉末尾几位（SteamID64 就是 17 位），
  // 与其给一个错的数字，不如原样保留字符串。
  if (/^-?\d+$/.test(raw)) {
    const num = Number(raw);
    return Number.isSafeInteger(num) ? num : raw;
  }
  if (/^-?\d*\.\d+$/.test(raw)) return Number(raw);
  return raw;
}

function parseMap(rows, start, indent, file) {
  const obj = {};
  let i = start;
  while (i < rows.length) {
    const row = rows[i];
    if (row.indent < indent) break;
    if (row.indent > indent) fail(file, row, '缩进跳级了，检查上一层的对齐');
    if (row.content === '-' || row.content.startsWith('- ')) break;

    const colon = keyColon(row.content);
    if (colon < 0) fail(file, row, `不是 key: value 形式：${row.content}`);
    const key = unquote(row.content.slice(0, colon).trim()) ?? row.content.slice(0, colon).trim();
    const rest = row.content.slice(colon + 1).trim();
    i += 1;

    if (rest === '') {
      if (i < rows.length && rows[i].indent > indent) {
        const [value, next] = parseBlock(rows, i, rows[i].indent, file);
        obj[key] = value;
        i = next;
      } else {
        obj[key] = null;
      }
      continue;
    }
    if (rest === '|' || rest === '>' || rest.startsWith('|') || rest.startsWith('>')) {
      fail(file, row, '暂不支持块标量（| 或 >），请写成单行');
    }
    obj[key] = parseScalar(rest, file, row);
  }
  return [obj, i];
}

function parseSeq(rows, start, indent, file) {
  const arr = [];
  let i = start;
  while (i < rows.length) {
    const row = rows[i];
    if (row.indent < indent) break;
    if (row.indent > indent) fail(file, row, '缩进跳级了，检查上一层的对齐');
    if (row.content !== '-' && !row.content.startsWith('- ')) break;

    const rest = row.content.slice(1).trim();
    i += 1;

    if (rest === '') {
      if (i < rows.length && rows[i].indent > indent) {
        const [value, next] = parseBlock(rows, i, rows[i].indent, file);
        arr.push(value);
        i = next;
      } else {
        arr.push(null);
      }
      continue;
    }
    // 只支持标量序列；"- key: value" 这种映射序列这里明确报错，避免解析出半成品
    if (keyColon(rest) >= 0) fail(file, row, '暂不支持「序列里放映射」，改用内联数组或普通映射');
    arr.push(parseScalar(rest, file, row));
  }
  return [arr, i];
}

function parseBlock(rows, start, indent, file) {
  const first = rows[start];
  if (first.content === '-' || first.content.startsWith('- ')) {
    return parseSeq(rows, start, indent, file);
  }
  return parseMap(rows, start, indent, file);
}

/**
 * 解析 YAML 文本。
 * @param {string} text
 * @param {{file?: string}} [options]
 * @returns {any}
 */
export function parseYaml(text, options = {}) {
  const file = options.file ?? 'yaml';
  const rows = tokenize(text, file);
  if (rows.length === 0) return {};
  const [value, next] = parseBlock(rows, 0, rows[0].indent, file);
  if (next < rows.length) fail(file, rows[next], `无法解析的内容：${rows[next].content}`);
  return value;
}

export { YamlError };

#!/usr/bin/env node

if (process.argv.includes('--version')) {
  process.stdout.write('fake-copilot 0.0.0\n');
  process.exit(0);
}

if (process.env.FAKE_COPILOT_FAIL === 'auth') {
  process.stderr.write('Authentication required. Please login to GitHub Copilot.\n');
  process.exit(1);
}

if (process.env.FAKE_COPILOT_REQUIRE_AVAILABLE_TOOLS_NONE === '1') {
  const availableToolsIndex = process.argv.indexOf('--available-tools');
  const denyToolIndex = process.argv.indexOf('--deny-tool');
  if (availableToolsIndex < 0 || process.argv[availableToolsIndex + 1] !== 'none' || (denyToolIndex >= 0 && process.argv[denyToolIndex + 1] === '*')) {
    process.stderr.write('Expected --available-tools none and no --deny-tool wildcard.\n');
    process.exit(42);
  }
}

if (process.env.FAKE_COPILOT_REQUIRE_EXTERNAL_MCP === '1') {
  const configIndex = process.argv.indexOf('--additional-mcp-config');
  const allowToolArgs = process.argv.flatMap((arg, index) => (arg === '--allow-tool' ? [process.argv[index + 1]] : []));
  if (configIndex < 0 || !process.argv[configIndex + 1]?.startsWith('@')) {
    process.stderr.write('Expected additional MCP config for external MCP.\n');
    process.exit(45);
  }
  const configPath = process.argv[configIndex + 1].slice(1);
  const config = JSON.parse(await import('node:fs/promises').then((fs) => fs.readFile(configPath, 'utf8')));
  const source = config.mcpServers.source;
  const sourceArgs = JSON.parse(source?.env?.REVIEW_ASSISTANT_EXTERNAL_MCP_ARGS_JSON || '[]');
  if (
    !source ||
    source.env?.REVIEW_ASSISTANT_EXTERNAL_MCP_COMMAND !== 'source-mcp' ||
    sourceArgs[0] !== 'stdio' ||
    source.args.some((arg) => arg.includes('secret-token')) ||
    source.env?.SOURCE_TOKEN !== 'secret-token' ||
    !allowToolArgs.includes('source(search)')
  ) {
    process.stderr.write('Expected external MCP server with token env and allowed tools.\n');
    process.exit(46);
  }
}

const promptIndex = process.argv.indexOf('-p');
const prompt = promptIndex >= 0 ? process.argv[promptIndex + 1] ?? '' : '';

if (process.env.FAKE_COPILOT_REQUIRE_CHAT_HISTORY === '1') {
  if (
    !prompt.includes('Conversation so far:') ||
    !prompt.includes('user: search for "configuration management"') ||
    !prompt.includes('assistant: Found results: vinsol/nectarcommerce README.md') ||
    !prompt.includes('User message:\nput them in turn 1 evidence') ||
    !prompt.includes('System prompt:\nSearch result persistence') ||
    !prompt.includes('run or re-run the relevant external search if structured result entries are not available') ||
    !prompt.includes('saved result content should be a relevant excerpt of actual source text returned by the MCP source') ||
    !prompt.includes('long enough to support later fact extraction and review') ||
    !prompt.includes('Do not synthesize provider-specific links from partial metadata')
  ) {
    process.stderr.write('Expected prompt to include prior search context and persistence guidance.\n');
    process.exit(47);
  }
}

if (prompt.includes('Selected record JSON')) {
  process.stderr.write('Record JSON must not be included in the startup prompt.\n');
  process.exit(43);
}

if (process.env.FAKE_COPILOT_REQUIRE_REVIEW_ASSISTANT_TOOLS === '1') {
  const availableToolsIndex = process.argv.indexOf('--available-tools');
  const configIndex = process.argv.indexOf('--additional-mcp-config');
  const allowToolArgs = process.argv.flatMap((arg, index) => (arg === '--allow-tool' ? [process.argv[index + 1]] : []));
  if (
    availableToolsIndex >= 0 ||
    configIndex < 0 ||
    !process.argv[configIndex + 1]?.startsWith('@') ||
    !process.argv.includes('--allow-all-tools') ||
    !allowToolArgs.includes('review_assistant(readRecord)') ||
    !allowToolArgs.includes('review_assistant(listTools)')
  ) {
    process.stderr.write('Expected callable Review Assistant MCP tool configuration.\n');
    process.exit(44);
  }
}

if (prompt.includes('slow-cancel')) {
  process.stdout.write('partial response');
  setInterval(() => undefined, 1000);
} else if (prompt.includes('summarize this record') && process.argv.includes('--additional-mcp-config')) {
  const result = await callReviewAssistantTool('readRecord', { includeSchema: false });
  process.stdout.write(`Record question: ${recordQuestion(result.record)}`);
  process.exit(0);
} else if (prompt.includes('persona and question') && process.argv.includes('--additional-mcp-config')) {
  const result = await callReviewAssistantTool('readRecord', { includeSchema: false });
  process.stdout.write(`Record persona: ${result.record.persona}\nRecord question: ${recordQuestion(result.record)}`);
  process.exit(0);
} else if (prompt.includes('call external source') && process.argv.includes('--additional-mcp-config')) {
  const result = await callExternalMcpTool('source', 'search', { query: 'harness' });
  process.stdout.write(`External result: ${result.content[0].text}`);
  process.exit(0);
} else {
  process.stdout.write('Streamed ');
  setTimeout(() => {
    process.stdout.write('Copilot response');
    process.exit(0);
  }, 25);
}

function recordQuestion(record) {
  return record.question || record.turns?.[0]?.question || record.turns?.[0]?.request || record.turns?.[0]?.input || record.turns?.[0]?.user;
}

async function callReviewAssistantTool(name, args) {
  const configIndex = process.argv.indexOf('--additional-mcp-config');
  const configPath = process.argv[configIndex + 1].slice(1);
  const config = JSON.parse(await import('node:fs/promises').then((fs) => fs.readFile(configPath, 'utf8')));
  const server = config.mcpServers.review_assistant;
  const child = await import('node:child_process').then(({ spawn }) =>
    spawn(server.command, server.args, { env: { ...process.env, ...server.env }, stdio: ['pipe', 'pipe', 'inherit'] })
  );
  let nextId = 1;
  const pending = new Map();
  let input = '';
  child.stdout.on('data', (chunk) => {
    input += chunk.toString('utf8');
    while (true) {
      const lineEnd = input.indexOf('\n');
      if (lineEnd < 0) {
        return;
      }
      const line = input.slice(0, lineEnd).trim();
      input = input.slice(lineEnd + 1);
      if (!line) {
        continue;
      }
      const message = JSON.parse(line);
      pending.get(message.id)?.(message);
      pending.delete(message.id);
    }
  });

  const request = (method, params) =>
    new Promise((resolve) => {
      const id = nextId++;
      pending.set(id, resolve);
      const body = JSON.stringify({ jsonrpc: '2.0', id, method, params });
      child.stdin.write(`${body}\n`);
    });

  await request('initialize', {});
  const response = await request('tools/call', { name, arguments: args });
  child.kill('SIGTERM');
  const text = response.result.content[0].text;
  return JSON.parse(text);
}

async function callExternalMcpTool(serverName, name, args) {
  const configIndex = process.argv.indexOf('--additional-mcp-config');
  const configPath = process.argv[configIndex + 1].slice(1);
  const config = JSON.parse(await import('node:fs/promises').then((fs) => fs.readFile(configPath, 'utf8')));
  const server = config.mcpServers[serverName];
  const child = await import('node:child_process').then(({ spawn }) =>
    spawn(server.command, server.args, { env: { ...process.env, ...server.env }, stdio: ['pipe', 'pipe', 'inherit'] })
  );
  let nextId = 1;
  const pending = new Map();
  let input = '';
  child.stdout.on('data', (chunk) => {
    input += chunk.toString('utf8');
    while (true) {
      const lineEnd = input.indexOf('\n');
      if (lineEnd < 0) {
        return;
      }
      const line = input.slice(0, lineEnd).trim();
      input = input.slice(lineEnd + 1);
      if (!line) {
        continue;
      }
      const message = JSON.parse(line);
      pending.get(message.id)?.(message);
      pending.delete(message.id);
    }
  });

  const request = (method, params) =>
    new Promise((resolve) => {
      const id = nextId++;
      pending.set(id, resolve);
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });

  await request('initialize', {});
  await request('tools/list', {});
  const response = await request('tools/call', { name, arguments: args });
  child.kill('SIGTERM');
  return response.result;
}

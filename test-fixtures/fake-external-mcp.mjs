#!/usr/bin/env node

let input = '';

process.stdin.on('data', (chunk) => {
  input += chunk.toString('utf8');
  processMessages();
});

function processMessages() {
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
    if (message.method === 'initialize') {
      send({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} } } });
    } else if (message.method === 'tools/list') {
      send({
        jsonrpc: '2.0',
        id: message.id,
        result: {
          tools: [{ name: 'search', description: 'Search fake external source.', inputSchema: { type: 'object' } }]
        }
      });
    } else if (message.method === 'tools/call') {
      send({
        jsonrpc: '2.0',
        id: message.id,
        result: { content: [{ type: 'text', text: 'found 2 fake external matches' }], isError: false }
      });
    }
  }
}

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

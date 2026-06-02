import { randomUUID } from 'node:crypto';

export const createAgentProvider = ({ providerMetadata, requestTool, normalizeProviderError }) => ({
  getStatus: async () => {
    if (process.env.FAKE_COPILOT_FAIL === 'auth') {
      return {
        provider: providerMetadata,
        availability: 'unavailable',
        error: normalizeProviderError(new Error('Authentication required. Please login to GitHub Copilot.'))
      };
    }
    return { provider: providerMetadata, availability: 'ready' };
  },
  startChat: async ({ requestId, prompt, context, callbacks }) => {
    assertPromptBoundary(prompt);
    assertToolConfiguration(context);

    let timer;
    const clear = () => {
      if (timer) {
        clearTimeout(timer);
        timer = undefined;
      }
    };

    if (prompt.includes('slow-cancel')) {
      callbacks.chunk('partial response');
      timer = setTimeout(() => undefined, 60_000);
      return {
        cancel: async () => clear(),
        dispose: async () => clear()
      };
    }

    timer = setTimeout(() => {
      void respond({ requestId, prompt, callbacks, requestTool });
    }, 5);

    return {
      cancel: async () => clear(),
      dispose: async () => clear()
    };
  }
});

const respond = async ({ requestId, prompt, callbacks, requestTool }) => {
  try {
    if (prompt.includes('summarize this record')) {
      const result = await callTool(requestId, requestTool, 'readRecord', { includeSchema: false });
      callbacks.chunk(`Record question: ${recordQuestion(result.record)}`);
    } else if (prompt.includes('persona and question')) {
      const result = await callTool(requestId, requestTool, 'readRecord', { includeSchema: false });
      callbacks.chunk(`Record persona: ${result.record.persona}\nRecord question: ${recordQuestion(result.record)}`);
    } else if (prompt.includes('call external source')) {
      callbacks.chunk('External result: found 2 fake external matches');
    } else {
      callbacks.chunk('Streamed ');
      callbacks.chunk('Copilot response');
    }
    callbacks.complete();
  } catch (error) {
    callbacks.error({
      code: 'PROVIDER_ERROR',
      message: error instanceof Error ? error.message : String(error),
      retryable: true
    });
  }
};

const callTool = async (requestId, requestTool, tool, args) => {
  const response = await requestTool(requestId, {
    tool,
    requestId: randomUUID(),
    arguments: args
  });
  if (!response.ok) {
    throw new Error(response.error.message);
  }
  return response.result;
};

const assertPromptBoundary = (prompt) => {
  if (prompt.includes('Selected record JSON')) {
    throw new Error('Record JSON must not be included in the startup prompt.');
  }
  if (
    process.env.FAKE_COPILOT_REQUIRE_CHAT_HISTORY === '1' &&
    (!prompt.includes('Conversation so far:') ||
      !prompt.includes('user: search for "configuration management"') ||
      !prompt.includes('assistant: Found results: vinsol/nectarcommerce README.md'))
  ) {
    throw new Error('Expected chat history in provider prompt.');
  }
};

const assertToolConfiguration = (context) => {
  if (process.env.FAKE_COPILOT_REQUIRE_AVAILABLE_TOOLS_NONE === '1' && (context.tools.length > 0 || (context.mcpServers ?? []).length > 0)) {
    throw new Error('Expected no Review Assistant tools or external MCP servers.');
  }

  if (process.env.FAKE_COPILOT_REQUIRE_REVIEW_ASSISTANT_TOOLS === '1') {
    const toolNames = context.tools.map((tool) => tool.name);
    if (!toolNames.includes('readRecord') || !toolNames.includes('listTools')) {
      throw new Error('Expected callable Review Assistant SDK tool configuration.');
    }
  }

  if (process.env.FAKE_COPILOT_REQUIRE_EXTERNAL_MCP === '1') {
    const source = (context.mcpServers ?? []).find((server) => server.id === 'source');
    if (
      !source ||
      source.command !== 'source-mcp' ||
      source.args[0] !== 'stdio' ||
      source.args.some((arg) => arg.includes('secret-token')) ||
      source.env?.SOURCE_TOKEN !== 'secret-token' ||
      !source.allowedTools?.includes('search')
    ) {
      throw new Error('Expected external MCP server with token env and allowed tools.');
    }
  }
};

const recordQuestion = (record) => record.question || record.turns?.[0]?.question || record.turns?.[0]?.request || record.turns?.[0]?.input || record.turns?.[0]?.user;

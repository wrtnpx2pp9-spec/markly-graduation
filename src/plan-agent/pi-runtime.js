'use strict';
const { SYSTEM } = require('./prompts');
const { createTools } = require('./tool-registry');
let loaded;
async function load() { return loaded ||= Promise.all([import('@earendil-works/pi-agent-core'), import('@earendil-works/pi-ai'), import('@earendil-works/pi-ai/providers/all')]); }
async function providerRuntime(config) {
  const [, , providers] = await load();
  if (config.baseUrl) throw Object.assign(Error('当前 Pi 只接受已内置供应商的官方地址；自定义网关需先增加受测适配器'), { code: 'provider_not_ready' });
  const provider = providers.builtinProviders().find(x => x.id === config.provider), model = provider?.getModels().find(x => x.id === config.model);
  if (!model) throw Object.assign(Error(`Pi 不认识供应商或模型：${config.provider}/${config.model}`), { code: 'provider_not_ready' });
  return { model, streamFn: (m, context, options) => provider.streamSimple(m, context, { ...options, maxTokens: config.maxOutputTokens }) };
}
async function run({ config, context, saveCandidate, signal, onEvent, systemPrompt = SYSTEM, tools, initialPrompt = '请先调用 read_plan_context，再编排并提交候选计划。不得只在文字中给出计划。' }) {
  if (signal?.aborted) return [];
  const [core, ai] = await load(), runtime = await providerRuntime(config); let turns = 0;
  if (signal?.aborted) return [];
  const agent = new core.Agent({ streamFn: runtime.streamFn, getApiKey: () => config.modelKey, toolExecution: 'sequential', shouldStopAfterTurn: () => ++turns >= config.maxTurns });
  agent.state.systemPrompt = systemPrompt; agent.state.model = runtime.model;
  agent.state.tools = tools || createTools(ai.Type, { context, saveCandidate }); agent.subscribe(onEvent || (() => {}));
  const abort = () => agent.abort();
  if (signal) signal.addEventListener('abort', abort, { once: true });
  try {
    await agent.prompt(initialPrompt);
    return agent.state.messages;
  } finally {
    signal?.removeEventListener('abort', abort);
  }
}
module.exports = { run, providerRuntime };

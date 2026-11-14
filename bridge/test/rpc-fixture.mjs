// Offline protocol fixture. Never imports a model or contacts any API.
import { appendFileSync } from 'node:fs';
let buffer = '';
const emit = value => process.stdout.write(JSON.stringify(value) + '\n');
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  buffer += chunk;
  let end;
  while ((end = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
    if (!line) continue;
    let command;
    try { command = JSON.parse(line); } catch { continue; }
    if (process.env.TEST_RPC_LOG) appendFileSync(process.env.TEST_RPC_LOG, command.type + '\n');
    let data = {};
    if (command.type === 'get_state') data = { sessionId: 'fake', isStreaming: false };
    if (command.type === 'prompt') {
      if (command.message === 'handled') data = { disposition: 'handled' };
      else if (command.message === 'hold') { data = { disposition: 'started' }; emit({ type: 'tool_execution_start', toolName: 'read' }); }
      else {
        data = { disposition: 'started' };
        if (['json-error', 'provider-error', 'recovered'].includes(command.message)) {
          emit({ type: 'message_end', message: { role: 'assistant', content: [], stopReason: 'error', errorMessage: command.message === 'json-error'
            ? '9router API error (400): {"message":"Invalid JSON body"} EXAMPLE_PRIVATE_VALUE'
            : '9router API error (503): EXAMPLE_PRIVATE_VALUE' } });
        }
        if (command.message === 'recovered') emit({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'Recovered' }], stopReason: 'stop' } });
        emit({ type: 'agent_settled', aborted: false });
      }
    }
    emit({ type: 'response', id: command.id, command: command.type, success: true, data });
    if (command.type === 'abort') emit({ type: 'agent_settled', aborted: true });
  }
});
process.stdin.on('end', () => process.exit(0));

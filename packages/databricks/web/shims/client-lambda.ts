/**
 * @aws-sdk/client-lambda 互換（ブラウザ）: predictStream の Lambda レスポンスストリーミングを
 * Databricks App の /api/predict-stream（チャンク転送）に置き換える。
 */
export class InvokeWithResponseStreamCommand {
  constructor(readonly input: { FunctionName?: string; Payload?: string | Uint8Array }) {}
}

export class LambdaClient {
  constructor(_config?: unknown) {}

  async send(cmd: InvokeWithResponseStreamCommand) {
    const res = await fetch('/api/predict-stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: typeof cmd.input.Payload === 'string' ? cmd.input.Payload : new TextDecoder().decode(cmd.input.Payload),
    });
    if (!res.ok || !res.body) {
      throw new Error(`predict-stream failed: ${res.status}`);
    }
    const reader = res.body.getReader();
    async function* events() {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value?.length) yield { PayloadChunk: { Payload: value } };
      }
      yield { InvokeComplete: {} };
    }
    return { EventStream: events(), StatusCode: 200 };
  }
}

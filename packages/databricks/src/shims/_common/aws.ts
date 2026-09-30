/**
 * AWS SDK v3 互換シムの共通部品。
 * Command は input を保持するだけ、Client#send が op 名で処理を振り分ける。
 */
// biome-ignore lint/suspicious/noExplicitAny: SDK 互換のため入力は緩く受ける
export type AnyInput = any;

export class ShimCommand<I = AnyInput> {
  static readonly op: string = '';
  readonly input: I;
  constructor(input: I = {} as I) {
    this.input = input;
  }
  get op(): string {
    return (this.constructor as typeof ShimCommand).op;
  }
}

export const command = <I = AnyInput>(op: string) =>
  class extends ShimCommand<I> {
    static readonly op = op;
  };

export class ServiceException extends Error {
  readonly $fault: 'client' | 'server';
  readonly $metadata = { httpStatusCode: 400 };
  constructor(name: string, message: string, fault: 'client' | 'server' = 'client') {
    super(message);
    this.name = name;
    this.$fault = fault;
  }
}

export const exception = (name: string) =>
  class extends ServiceException {
    constructor(opts: { message?: string } | string = {}) {
      super(name, typeof opts === 'string' ? opts : (opts.message ?? name));
    }
  };

export type Handlers = Record<string, (input: AnyInput) => Promise<unknown>>;

export class ShimClient {
  readonly config: unknown;
  protected handlers: Handlers = {};
  constructor(config: unknown = {}) {
    this.config = config;
  }
  async send(cmd: ShimCommand): Promise<AnyInput> {
    const h = this.handlers[cmd.op];
    if (!h) {
      throw new ServiceException('NotSupportedOnDatabricks', `${cmd.op} is not supported on Databricks`);
    }
    return { $metadata: { httpStatusCode: 200 }, ...((await h(cmd.input)) as object) };
  }
  destroy(): void {}
}

export const clientWith = (handlers: Handlers) =>
  class extends ShimClient {
    constructor(config?: unknown) {
      super(config);
      this.handlers = handlers;
    }
  };

/** 何もしないクライアント（監視・ログ転送など Databricks 側で不要なもの） */
export const noopHandlers = (ops: string[]): Handlers =>
  Object.fromEntries(ops.map((op) => [op, async () => ({})]));

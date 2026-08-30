export class HttpError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export class RunCancelledError extends Error {
  constructor() {
    super("Run cancelled");
    this.name = "RunCancelledError";
  }
}

export class TokenBudgetExceededError extends Error {
  constructor() {
    super("Token usage is up. Agent paused until the budget is increased or set to unlimited.");
    this.name = "TokenBudgetExceededError";
  }
}

export class AgentBusyError extends Error {
  constructor() {
    super("This Agent is still working on the previous message. Please wait for it to finish.");
    this.name = "AgentBusyError";
  }
}

import { describe, it, expect } from "vitest";
import { logger } from "../logger";

describe("logger", () => {
  it("exports a pino logger instance", () => {
    expect(logger).toBeDefined();
    expect(typeof logger.info).toBe("function");
    expect(typeof logger.error).toBe("function");
    expect(typeof logger.warn).toBe("function");
    expect(typeof logger.debug).toBe("function");
  });

  it("has the expected log level in test environment", () => {
    // NODE_ENV is not 'production' in tests, so level should be 'debug'
    expect(logger.level).toBe("debug");
  });
});

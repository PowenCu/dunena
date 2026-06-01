// ── Redis Adapter RESP Parser Unit Tests ────────────────────
// Tests the RESP2 protocol parser and serializer.

import { describe, it, expect } from "bun:test";
import { RESP } from "../src/parser";

describe("RESP Serializer", () => {
  it("should encode simple strings", () => {
    expect(RESP.simpleString("OK")).toBe("+OK\r\n");
    expect(RESP.simpleString("PONG")).toBe("+PONG\r\n");
  });

  it("should encode bulk strings", () => {
    expect(RESP.bulkString("hello")).toBe("$5\r\nhello\r\n");
    expect(RESP.bulkString("")).toBe("$0\r\n\r\n");
    expect(RESP.bulkString(null)).toBe("$-1\r\n");
  });

  it("should encode errors", () => {
    expect(RESP.error("ERR unknown command")).toBe("-ERR unknown command\r\n");
  });

  it("should encode integers", () => {
    expect(RESP.integer(42)).toBe(":42\r\n");
    expect(RESP.integer(0)).toBe(":0\r\n");
    expect(RESP.integer(-1)).toBe(":-1\r\n");
  });

  it("should encode arrays", () => {
    const items = [RESP.bulkString("hello"), RESP.bulkString("world")];
    const result = RESP.array(items);
    expect(result).toBe("*2\r\n$5\r\nhello\r\n$5\r\nworld\r\n");
  });

  it("should encode empty arrays", () => {
    expect(RESP.array([])).toBe("*0\r\n");
  });

  it("should encode arrays with null elements", () => {
    const items = [RESP.bulkString("hello"), RESP.bulkString(null)];
    const result = RESP.array(items);
    expect(result).toBe("*2\r\n$5\r\nhello\r\n$-1\r\n");
  });

  it("should handle multi-byte characters in bulk strings", () => {
    const result = RESP.bulkString("héllo");
    // Buffer.from("héllo").length is 6 (é is 2 bytes)
    const expectedLen = Buffer.from("héllo").length;
    expect(result).toBe(`$${expectedLen}\r\nhéllo\r\n`);
  });
});

describe("RESP Parser", () => {
  it("should parse a single command", () => {
    const buf = Buffer.from("*1\r\n$4\r\nPING\r\n");
    const { commands, offset } = RESP.parse(buf);
    expect(commands.length).toBe(1);
    expect(commands[0]).toEqual(["PING"]);
    expect(offset).toBe(buf.length);
  });

  it("should parse a command with arguments", () => {
    const buf = Buffer.from("*3\r\n$3\r\nSET\r\n$5\r\nmykey\r\n$7\r\nmyvalue\r\n");
    const { commands, offset } = RESP.parse(buf);
    expect(commands.length).toBe(1);
    expect(commands[0]).toEqual(["SET", "mykey", "myvalue"]);
    expect(offset).toBe(buf.length);
  });

  it("should parse multiple commands in one buffer", () => {
    const buf = Buffer.from(
      "*1\r\n$4\r\nPING\r\n" +
      "*3\r\n$3\r\nSET\r\n$1\r\na\r\n$1\r\nb\r\n"
    );
    const { commands, offset } = RESP.parse(buf);
    expect(commands.length).toBe(2);
    expect(commands[0]).toEqual(["PING"]);
    expect(commands[1]).toEqual(["SET", "a", "b"]);
    expect(offset).toBe(buf.length);
  });

  it("should handle incomplete buffers gracefully", () => {
    // Only part of a command
    const buf = Buffer.from("*3\r\n$3\r\nSET\r\n$5\r\nmy");
    const { commands, offset } = RESP.parse(buf);
    expect(commands.length).toBe(0);
    expect(offset).toBe(0);
  });

  it("should handle empty buffer", () => {
    const { commands, offset } = RESP.parse(Buffer.alloc(0));
    expect(commands.length).toBe(0);
    expect(offset).toBe(0);
  });

  it("should parse MGET command", () => {
    const buf = Buffer.from("*4\r\n$4\r\nMGET\r\n$1\r\na\r\n$1\r\nb\r\n$1\r\nc\r\n");
    const { commands, offset } = RESP.parse(buf);
    expect(commands.length).toBe(1);
    expect(commands[0]).toEqual(["MGET", "a", "b", "c"]);
    expect(offset).toBe(buf.length);
  });

  it("should handle incomplete array header", () => {
    const buf = Buffer.from("*3\r");
    const { commands, offset } = RESP.parse(buf);
    expect(commands.length).toBe(0);
    expect(offset).toBe(0);
  });

  it("should handle incomplete bulk string length", () => {
    const buf = Buffer.from("*1\r\n$3\r");
    const { commands, offset } = RESP.parse(buf);
    expect(commands.length).toBe(0);
    expect(offset).toBe(0);
  });

  it("should parse SET with EX option", () => {
    const buf = Buffer.from(
      "*5\r\n$3\r\nSET\r\n$3\r\nfoo\r\n$3\r\nbar\r\n$2\r\nEX\r\n$2\r\n60\r\n"
    );
    const { commands, offset } = RESP.parse(buf);
    expect(commands.length).toBe(1);
    expect(commands[0]).toEqual(["SET", "foo", "bar", "EX", "60"]);
    expect(offset).toBe(buf.length);
  });

  it("should partially parse when buffer contains complete and incomplete commands", () => {
    const complete = "*1\r\n$4\r\nPING\r\n";
    const incomplete = "*3\r\n$3\r\nSET\r\n";
    const buf = Buffer.from(complete + incomplete);
    const { commands, offset } = RESP.parse(buf);
    expect(commands.length).toBe(1);
    expect(commands[0]).toEqual(["PING"]);
    expect(offset).toBe(complete.length);
  });
});

describe("RESP Roundtrip", () => {
  it("should handle complex multi-command pipeline", () => {
    // Simulate a pipeline of: SET key1 val1, SET key2 val2, MGET key1 key2
    const pipeline = Buffer.from(
      "*3\r\n$3\r\nSET\r\n$4\r\nkey1\r\n$4\r\nval1\r\n" +
      "*3\r\n$3\r\nSET\r\n$4\r\nkey2\r\n$4\r\nval2\r\n" +
      "*3\r\n$4\r\nMGET\r\n$4\r\nkey1\r\n$4\r\nkey2\r\n"
    );
    const { commands, offset } = RESP.parse(pipeline);
    expect(commands.length).toBe(3);
    expect(commands[0]).toEqual(["SET", "key1", "val1"]);
    expect(commands[1]).toEqual(["SET", "key2", "val2"]);
    expect(commands[2]).toEqual(["MGET", "key1", "key2"]);
    expect(offset).toBe(pipeline.length);
  });
});

import "./setup";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Socket } from "node:net";
import { smtpProvider } from "../../src/lib/email/providers/smtp";
import { OUTBOUND_ID_HEADER, type ResolvedEmailConfig } from "../../src/lib/email/types";

// A minimal in-process SMTP sink: enough RFC 5321 to accept one message.
// This proves the adapter speaks real SMTP on the wire, not a mock of our
// own code. rejectRcpt simulates a server that 550s the recipient.
function startSmtpSink(rejectRcpt = false): Promise<{
  port: number;
  received: string[];
  close: () => Promise<void>;
}> {
  const received: string[] = [];
  const server = createServer((socket: Socket) => {
    let inData = false;
    let buffer = "";
    socket.write("220 sink.local ESMTP test\r\n");
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      let idx: number;
      while ((idx = buffer.indexOf("\r\n")) !== -1) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        if (inData) {
          if (line === ".") {
            inData = false;
            socket.write("250 OK queued\r\n");
          } else {
            received.push(line);
          }
          continue;
        }
        const verb = line.split(" ")[0].toUpperCase();
        if (verb === "EHLO" || verb === "HELO") {
          socket.write("250-sink.local\r\n250 8BITMIME\r\n");
        } else if (verb === "MAIL") {
          socket.write("250 OK\r\n");
        } else if (verb === "RCPT") {
          socket.write(rejectRcpt ? "550 5.1.1 no such user\r\n" : "250 OK\r\n");
        } else if (verb === "DATA") {
          inData = true;
          socket.write("354 go ahead\r\n");
        } else if (verb === "QUIT") {
          socket.write("221 bye\r\n");
          socket.end();
        } else {
          socket.write("250 OK\r\n");
        }
      }
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve({
        port: typeof address === "object" && address ? address.port : 0,
        received,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

function config(port: number): ResolvedEmailConfig {
  return {
    provider: "smtp",
    fromAddress: "msa@example.com",
    secrets: {},
    smtp: { host: "127.0.0.1", port, secure: false },
    baseUrl: "https://msa.example.com",
  };
}

test("smtp adapter delivers a real message over the wire", async () => {
  const sink = await startSmtpSink();
  try {
    const result = await smtpProvider.send(
      {
        to: "rcpt@example.com",
        from: "msa@example.com",
        subject: "Live SMTP test",
        text: "hello over real sockets",
        headers: { [OUTBOUND_ID_HEADER]: "ob-live-1" },
      },
      config(sink.port),
    );
    assert.equal(result.ok, true);
    const raw = sink.received.join("\n");
    assert.match(raw, /Subject: Live SMTP test/);
    // Header names are case-insensitive; nodemailer re-cases them on the wire.
    assert.ok(
      raw.toLowerCase().includes(`${OUTBOUND_ID_HEADER.toLowerCase()}: ob-live-1`),
      "correlation header must be on the wire",
    );
    assert.match(raw, /hello over real sockets/);
  } finally {
    await sink.close();
  }
});

test("smtp 550 rejection is a permanent failure, as data not an exception", async () => {
  const sink = await startSmtpSink(true);
  try {
    const result = await smtpProvider.send(
      {
        to: "nobody@example.com",
        from: "msa@example.com",
        subject: "x",
        text: "x",
        headers: {},
      },
      config(sink.port),
    );
    assert.ok(!result.ok);
    if (!result.ok) {
      assert.equal(result.permanent, true);
      assert.match(result.error, /no such user|550/);
    }
  } finally {
    await sink.close();
  }
});

test("connection refused is a retryable failure", async () => {
  const result = await smtpProvider.send(
    { to: "a@b.co", from: "msa@example.com", subject: "x", text: "x", headers: {} },
    config(1), // nothing listens on port 1
  );
  assert.ok(!result.ok);
  if (!result.ok) assert.equal(result.permanent, false);
});

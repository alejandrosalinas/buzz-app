import assert from "node:assert/strict";
import test from "node:test";
import { policyRelay } from "../browser/policy-relay.mjs";

test("outbound ephemeral fanout drops without subscribers while inbound injection stays strict", () => {
  const report = { unexpected: [] };
  const relay = policyRelay({ report });
  const event = { kind: 20002, content: "", tags: [["h", "alpha"]] };
  assert.doesNotThrow(() =>
    relay.publish("primary", event, { requireSubscriber: false }),
  );
  assert.throws(
    () => relay.publish("primary", event),
    /explicit production channel REQ/,
  );
  const socket = relay.socket("wss://primary.test");
  socket.routes.set("typing", [{ kinds: [20002], "#h": ["alpha"] }]);
  relay.publish("primary", event, { requireSubscriber: false });
  assert.deepEqual(report.wireFrames, [["EVENT", "typing", event]]);
  socket.close();
  assert.doesNotThrow(() =>
    relay.publish("primary", event, { requireSubscriber: false }),
  );
  assert.throws(
    () => relay.publish("primary", event),
    /explicit production channel REQ/,
  );
  assert.equal(report.wireFrames.length, 1);
});

test("a publication accepted after its page closed skips only the delivery check", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const report = { unexpected: [] };
  const accepted = [];
  const relay = policyRelay({
    report,
    acceptPublication(community, event) {
      accepted.push(event);
      relay.publish(community, event);
    },
  });
  const event = {
    id: "reaction",
    kind: 7,
    content: "+",
    tags: [["h", "alpha"]],
  };
  const socket = relay.socket("wss://primary.test");
  socket.authenticated = true;
  socket.send(JSON.stringify(["EVENT", event]));
  socket.close(); // The page closes before the acceptance timer fires.
  t.mock.timers.tick(0);
  assert.deepEqual(accepted, [event]);
  assert.deepEqual(report.unexpected, []);
  // With a socket still open in the community, delivery is checked as before.
  const open = relay.socket("wss://primary.test");
  open.authenticated = true;
  open.send(JSON.stringify(["EVENT", event]));
  assert.throws(() => t.mock.timers.tick(0), /explicit production channel REQ/);
  assert.equal(accepted.length, 2);
  // Outside an acceptance, publish stays strict even with no socket open.
  open.close();
  assert.throws(
    () => relay.publish("primary", event),
    /explicit production channel REQ/,
  );
});

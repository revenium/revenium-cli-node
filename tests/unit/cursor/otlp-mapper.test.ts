import { describe, it, expect } from "vitest";
import {
  buildOtlpPayload,
  isValidTimestamp,
} from "../../../src/cursor/core/transform/otlp-mapper.js";
import { computeEventHash } from "../../../src/cursor/core/sync/deduplicator.js";
import type { CursorUsageEvent } from "../../../src/cursor/types.js";
import { createUsageEvent, createCursorConfig } from "../../helpers/fixtures.js";

describe("buildOtlpPayload", () => {
  it("returns valid OTLP structure", () => {
    const payload = buildOtlpPayload([createUsageEvent()], createCursorConfig());
    expect(payload.resourceLogs).toHaveLength(1);
    expect(payload.resourceLogs[0].scopeLogs).toHaveLength(1);
    expect(payload.resourceLogs[0].scopeLogs[0].logRecords).toHaveLength(1);
  });

  it("sets service.name resource attribute", () => {
    const payload = buildOtlpPayload([createUsageEvent()], createCursorConfig());
    const attrs = payload.resourceLogs[0].resource?.attributes ?? [];
    const serviceName = attrs.find((a) => a.key === "service.name");
    expect(serviceName?.value.stringValue).toBe("cursor-ide");
  });

  it("includes organization.name when present", () => {
    const config = createCursorConfig({ organizationName: "Acme" });
    const payload = buildOtlpPayload([createUsageEvent()], config);
    const attrs = payload.resourceLogs[0].resource?.attributes ?? [];
    const orgName = attrs.find((a) => a.key === "organization.name");
    expect(orgName?.value.stringValue).toBe("Acme");
  });

  it("sends a punctuated organization.name verbatim, as the test command does", () => {
    const config = createCursorConfig({ organizationName: "Acme, Inc." });
    const payload = buildOtlpPayload([createUsageEvent()], config);
    const attrs = payload.resourceLogs[0].resource?.attributes ?? [];
    const orgName = attrs.find((a) => a.key === "organization.name");
    expect(orgName?.value.stringValue).toBe("Acme, Inc.");
  });

  it("includes product.name when present", () => {
    const config = createCursorConfig({ productName: "Widget" });
    const payload = buildOtlpPayload([createUsageEvent()], config);
    const attrs = payload.resourceLogs[0].resource?.attributes ?? [];
    const prodName = attrs.find((a) => a.key === "product.name");
    expect(prodName?.value.stringValue).toBe("Widget");
  });

  it("includes user.email when present", () => {
    const config = createCursorConfig({ email: "dev@co.com" });
    const payload = buildOtlpPayload([createUsageEvent()], config);
    const attrs = payload.resourceLogs[0].resource?.attributes ?? [];
    const email = attrs.find((a) => a.key === "user.email");
    expect(email?.value.stringValue).toBe("dev@co.com");
  });

  it("computes BigInt nanoseconds for timeUnixNano", () => {
    const event = createUsageEvent({ timestamp: 1700000000000 });
    const payload = buildOtlpPayload([event], createCursorConfig());
    const record = payload.resourceLogs[0].scopeLogs[0].logRecords[0];
    expect(record.timeUnixNano).toBe((BigInt(1700000000000) * 1_000_000n).toString());
  });

  it("maps event fields to log attributes", () => {
    const event = createUsageEvent({
      model: "gpt-4",
      tokenUsage: {
        inputTokens: 100,
        outputTokens: 50,
        cacheWriteTokens: 10,
        cacheReadTokens: 20,
        totalCents: 500,
      },
    });
    const payload = buildOtlpPayload([event], createCursorConfig());
    const attrs = payload.resourceLogs[0].scopeLogs[0].logRecords[0].attributes;

    const getAttr = (key: string) => attrs.find((a) => a.key === key)?.value.stringValue;

    expect(getAttr("model")).toBe("gpt-4");
    expect(getAttr("input_tokens")).toBe("100");
    expect(getAttr("output_tokens")).toBe("50");
    expect(getAttr("cache_read_tokens")).toBe("20");
    expect(getAttr("cache_creation_tokens")).toBe("10");
    expect(getAttr("cost_usd")).toBe("5.000000");
    expect(getAttr("billing.kind")).toBe("Usage-based");
  });

  describe.each([
    "Included in Pro",
    "Included in Pro+",
    "Included in Business",
    "Included in Ultra",
    "included in business",
  ])("plan-included kind %s", (kind) => {
    const mapIncludedEvent = () => {
      const event = createUsageEvent({
        kind,
        tokenUsage: {
          inputTokens: 100,
          outputTokens: 50,
          cacheWriteTokens: 10,
          cacheReadTokens: 20,
          totalCents: 40.167,
        },
      });
      const attrs = buildOtlpPayload([event], createCursorConfig()).resourceLogs[0].scopeLogs[0]
        .logRecords[0].attributes;
      return {
        event,
        getAttr: (key: string) => attrs.find((a) => a.key === key)?.value.stringValue,
      };
    };

    it("reports no cost", () => {
      expect(mapIncludedEvent().getAttr("cost_usd")).toBe("0.000000");
    });

    it("emits billing.kind verbatim", () => {
      expect(mapIncludedEvent().getAttr("billing.kind")).toBe(kind);
    });

    it("keeps transaction_id tied to the raw event", () => {
      const { event, getAttr } = mapIncludedEvent();
      expect(getAttr("transaction_id")).toBe(computeEventHash(event).substring(0, 32));
    });
  });

  it("bills events whose kind is not a string", () => {
    const event = createUsageEvent({
      kind: undefined as unknown as string,
      tokenUsage: {
        inputTokens: 100,
        outputTokens: 50,
        cacheWriteTokens: 10,
        cacheReadTokens: 20,
        totalCents: 500,
      },
    });
    const attrs = buildOtlpPayload([event], createCursorConfig()).resourceLogs[0].scopeLogs[0]
      .logRecords[0].attributes;

    expect(attrs.find((a) => a.key === "cost_usd")?.value.stringValue).toBe("5.000000");
  });

  it("handles multiple events", () => {
    const events = [createUsageEvent(), createUsageEvent({ model: "gpt-3.5" })];
    const payload = buildOtlpPayload(events, createCursorConfig());
    expect(payload.resourceLogs[0].scopeLogs[0].logRecords).toHaveLength(2);
  });

  describe("Cursor Admin API documented example", () => {
    const documentedEvents = [
      createUsageEvent({
        timestamp: 1700000000000,
        model: "claude-4-sonnet",
        kind: "Usage-based",
        tokenUsage: {
          inputTokens: 100,
          outputTokens: 50,
          cacheWriteTokens: 10,
          cacheReadTokens: 20,
          totalCents: 20.1823,
        },
        chargedCents: 21.3623,
      }),
      createUsageEvent({
        timestamp: 1700000001000,
        model: "gpt-5",
        kind: "Usage-based",
        tokenUsage: {
          inputTokens: 200,
          outputTokens: 80,
          cacheWriteTokens: 5,
          cacheReadTokens: 15,
          totalCents: 40.167,
        },
        chargedCents: 37.33,
      }),
      createUsageEvent({
        timestamp: 1700000002000,
        model: "claude-4-sonnet",
        kind: "Included in Business",
        tokenUsage: null,
        chargedCents: 8,
      }),
    ];

    const costsOf = (events: CursorUsageEvent[]) =>
      buildOtlpPayload(events, createCursorConfig()).resourceLogs[0].scopeLogs[0].logRecords.map(
        (record) => record.attributes.find((a) => a.key === "cost_usd")?.value.stringValue,
      );

    it("sends each event at the amount Cursor charged", () => {
      expect(costsOf(documentedEvents)).toEqual(["0.213623", "0.373300", "0.080000"]);
    });

    it("totals the charged amounts", () => {
      const total = costsOf(documentedEvents).reduce((sum, cost) => sum + Number(cost), 0);
      expect(total).toBeCloseTo(0.666923, 6);
    });

    it("keeps transaction_id independent of chargedCents", () => {
      const records = buildOtlpPayload(documentedEvents, createCursorConfig()).resourceLogs[0]
        .scopeLogs[0].logRecords;

      documentedEvents.forEach((event, index) => {
        const eventWithoutCharge: CursorUsageEvent = { ...event };
        delete eventWithoutCharge.chargedCents;
        expect(
          records[index].attributes.find((a) => a.key === "transaction_id")?.value.stringValue,
        ).toBe(computeEventHash(eventWithoutCharge).substring(0, 32));
      });
    });

    const fiveDollarsOfTokens = {
      inputTokens: 100,
      outputTokens: 50,
      cacheWriteTokens: 10,
      cacheReadTokens: 20,
      totalCents: 500,
    };

    it("reports no cost for a non-chargeable event without chargedCents", () => {
      const event = createUsageEvent({ isChargeable: false, tokenUsage: fiveDollarsOfTokens });
      expect(costsOf([event])).toEqual(["0.000000"]);
    });

    it("reports no cost when Cursor charged exactly zero", () => {
      const event = createUsageEvent({ chargedCents: 0, tokenUsage: fiveDollarsOfTokens });
      expect(costsOf([event])).toEqual(["0.000000"]);
    });

    it("falls back to token cost when chargedCents is null", () => {
      const event = createUsageEvent({ chargedCents: null, tokenUsage: fiveDollarsOfTokens });
      expect(costsOf([event])).toEqual(["5.000000"]);
    });

    it("falls back to token cost when chargedCents is NaN", () => {
      const event = createUsageEvent({ chargedCents: NaN, tokenUsage: fiveDollarsOfTokens });
      expect(costsOf([event])).toEqual(["5.000000"]);
    });

    it("falls back to token cost when isChargeable is null", () => {
      const event = createUsageEvent({ isChargeable: null, tokenUsage: fiveDollarsOfTokens });
      expect(costsOf([event])).toEqual(["5.000000"]);
    });

    const chargeabilityOf = (events: CursorUsageEvent[]) =>
      buildOtlpPayload(events, createCursorConfig()).resourceLogs[0].scopeLogs[0].logRecords.map(
        (record) =>
          record.attributes.find((a) => a.key === "billing.chargeable")?.value.stringValue,
      );

    it("marks a zero-cost event as not chargeable so it is not re-priced", () => {
      const events = [
        createUsageEvent({ chargedCents: 0, tokenUsage: fiveDollarsOfTokens }),
        createUsageEvent({ isChargeable: false, tokenUsage: fiveDollarsOfTokens }),
        createUsageEvent({ chargedCents: 21.3623, tokenUsage: fiveDollarsOfTokens }),
      ];

      expect(chargeabilityOf(events)).toEqual(["false", "false", "true"]);
    });

    it("marks a plan-included event as not chargeable", () => {
      const event = createUsageEvent({
        kind: "Included in Business",
        tokenUsage: fiveDollarsOfTokens,
      });

      expect(chargeabilityOf([event])).toEqual(["false"]);
    });

    it("omits chargeability when Cursor reported no usable amount", () => {
      const events = [
        createUsageEvent({ chargedCents: null, tokenUsage: fiveDollarsOfTokens }),
        createUsageEvent({ chargedCents: null, isChargeable: true, tokenUsage: null }),
        createUsageEvent({ chargedCents: NaN, tokenUsage: fiveDollarsOfTokens }),
      ];

      expect(chargeabilityOf(events)).toEqual([undefined, undefined, undefined]);
    });

    it("keeps the token-cost fallback for an event with no reported amount", () => {
      const event = createUsageEvent({ chargedCents: null, tokenUsage: fiveDollarsOfTokens });
      expect(costsOf([event])).toEqual(["5.000000"]);
    });
  });

  it("sets body to cursor_ide.api_response", () => {
    const payload = buildOtlpPayload([createUsageEvent()], createCursorConfig());
    const record = payload.resourceLogs[0].scopeLogs[0].logRecords[0];
    expect(record.body.stringValue).toBe("cursor_ide.api_response");
  });
});

describe("isValidTimestamp", () => {
  it("accepts a valid millisecond timestamp", () => {
    expect(isValidTimestamp(1700000000000)).toBe(true);
  });

  it("accepts small positive integers", () => {
    expect(isValidTimestamp(1)).toBe(true);
  });

  it("rejects NaN", () => {
    expect(isValidTimestamp(NaN)).toBe(false);
  });

  it("rejects Infinity", () => {
    expect(isValidTimestamp(Infinity)).toBe(false);
    expect(isValidTimestamp(-Infinity)).toBe(false);
  });

  it("rejects zero", () => {
    expect(isValidTimestamp(0)).toBe(false);
  });

  it("rejects negative numbers", () => {
    expect(isValidTimestamp(-1700000000000)).toBe(false);
  });

  it("rejects non-integer numbers", () => {
    expect(isValidTimestamp(1700000000000.5)).toBe(false);
  });

  it("rejects values outside the range a Date can represent", () => {
    expect(isValidTimestamp(8_640_000_000_000_000)).toBe(true);
    expect(isValidTimestamp(8_640_000_000_000_001)).toBe(false);
    expect(isValidTimestamp(1.7e18)).toBe(false);
  });

  it("rejects undefined", () => {
    expect(isValidTimestamp(undefined)).toBe(false);
  });

  it("rejects null", () => {
    expect(isValidTimestamp(null)).toBe(false);
  });

  it("rejects strings", () => {
    expect(isValidTimestamp("1700000000000")).toBe(false);
  });
});

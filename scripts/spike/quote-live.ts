// 1.7f 착수 전 실측: 필사 문구 수집(웹검색)의 비용·검색 횟수·2곳 확인 통과율. 저장하지 않는다(DB·텔레그램 미사용).
import "dotenv/config";
import Anthropic from "@anthropic-ai/sdk";
import type { Product } from "../../docs/contract/domain.js";
import { pickWebQuote } from "../../src/draft/quote.js";
import { estimateCostKrw } from "../../src/llm/cost.js";
import type { LlmUsageReport } from "../../src/llm/body-generator.js";
import { createQuoteCollector } from "../../src/llm/quote-collector.js";

const books: [string, string][] = [["데미안", "헤르만 헤세"], ["불편한 편의점", "김호연"]];
const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY ?? "" });
for (const [title, author] of books) {
  const usages: LlmUsageReport[] = [];
  const product: Product = { externalId: "x", source: "yes24", category: "book", affiliate: "yes24", title, url: "https://www.yes24.com/addon/x", priceKrw: null, priceAsOf: null, specs: { 저자: author } };
  const found = await createQuoteCollector({ client, onUsage: (u) => void usages.push(u) }).collect(product);
  const picked = pickWebQuote(found, product);
  const krw = usages.reduce((sum, u) => sum + estimateCostKrw(u.model, u), 0);
  const searches = usages.reduce((sum, u) => sum + (u.webSearchRequests ?? 0), 0);
  console.log(JSON.stringify({ title, searches, krw: Math.round(krw), candidates: found.candidates, evidence: found.evidence.length, picked: picked?.quote.text ?? null, sites: picked?.urls.length ?? 0 }));
}

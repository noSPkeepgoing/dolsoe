import type { ApplianceBody, ComparisonFact, Product } from "@contract/domain.js";
import { HOUSEHOLD_BY_LITERS } from "@contract/domain.js";

const CAPACITY_KEY = "용량";
const LITERS = /(\d+(?:[.,]\d+)?)\s*(ml|mL|ML|㎖|l|L|ℓ|리터)/;

/** "3.5L" · "5 리터" · "800ml" → 리터 수. 읽을 수 없으면 null. */
export function parseLiters(text: string | undefined): number | null {
  const match = text === undefined ? null : LITERS.exec(text);
  if (match === null) return null;
  const value = Number(match[1]!.replace(",", "."));
  if (!Number.isFinite(value) || value <= 0) return null;
  return /^(ml|㎖)$/i.test(match[2]!) ? value / 1000 : value;
}

const won = (value: number): string => `${Math.round(value).toLocaleString("en-US")}원`;
const liters = (value: number): string => `${Number(value.toFixed(2))}L`;

export function householdFor(litersValue: number): string {
  return (HOUSEHOLD_BY_LITERS.find((row) => litersValue <= row.maxLiters) ?? HOUSEHOLD_BY_LITERS.at(-1)!).label;
}

const minBy = <T>(items: readonly T[], key: (item: T) => number): T => items.reduce((best, item) => (key(item) < key(best) ? item : best));
const maxBy = <T>(items: readonly T[], key: (item: T) => number): T => items.reduce((best, item) => (key(item) > key(best) ? item : best));

/**
 * REQ-028: 글에 들어간 제품끼리만 비교해 코드가 근거 팩트를 만든다. 모델은 이 목록만 근거로 문장을 쓰고 `factIds`로 가리킨다.
 * 데이터가 모자라면 그 팩트는 만들지 않는다(예: 용량이 하나뿐이면 용량 1위 없음, 가격이 없으면 리터당 가격 없음) — 모르는 것은 판단하지 않는다.
 */
export function computeFacts(products: readonly Product[]): ComparisonFact[] {
  const facts: ComparisonFact[] = [];
  const priced = products.flatMap((product) => (product.priceKrw === null ? [] : [{ product, price: product.priceKrw }]));
  const withCapacity = products.flatMap((product) => {
    const value = parseLiters(product.specs[CAPACITY_KEY]);
    return value === null ? [] : [{ product, liters: value }];
  });
  const withBoth = withCapacity.flatMap((item) => (item.product.priceKrw === null ? [] : [{ ...item, price: item.product.priceKrw }]));

  if (priced.length >= 2) {
    const lowest = minBy(priced, (item) => item.price);
    facts.push({ id: "price_min", text: `가격이 가장 낮은 제품은 ${lowest.product.title}(${won(lowest.price)})`, productExternalId: lowest.product.externalId });
  }
  if (withCapacity.length >= 2) {
    const biggest = maxBy(withCapacity, (item) => item.liters);
    facts.push({ id: "capacity_max", text: `용량이 가장 큰 제품은 ${biggest.product.title}(${liters(biggest.liters)})`, productExternalId: biggest.product.externalId });
  }
  if (withBoth.length >= 2) {
    const best = minBy(withBoth, (item) => item.price / item.liters);
    facts.push({
      id: "price_per_liter_min",
      text: `리터당 가격이 가장 낮은 제품은 ${best.product.title}(리터당 ${won(best.price / best.liters)})`,
      productExternalId: best.product.externalId,
    });
  }
  for (const item of withCapacity) {
    facts.push({
      id: `household:${item.product.externalId}`,
      text: `${item.product.title}(${liters(item.liters)})는 ${householdFor(item.liters)} 가구에 맞는 용량대`,
      productExternalId: item.product.externalId,
    });
  }
  return facts;
}

const NUMBER = /\d[\d,]*(?:\.\d+)?/g;
const numbersIn = (text: string): string[] => (text.match(NUMBER) ?? []).map((n) => n.replaceAll(",", ""));
/** 수치+단위. 단위 없는 숫자("3종", "2개")는 판단 수치가 아니라 세지 않는다. */
const MEASURED = /(\d[\d,]*(?:\.\d+)?)\s*(?:만\s*원|원|L|ℓ|리터|ml|W|dB|kg|㎡|평)/gi;

/**
 * REQ-028 검증: 추천이 가리키는 `factIds`는 코드가 계산한 팩트여야 하고, 판단 문장(결론·추천 이유)의 수치+단위는
 * 팩트·상품 스펙·가격에 있는 값이어야 한다. 모델이 지어낸 용량·가격을 걸러 재생성에 넘긴다.
 */
export function findFactProblems(body: ApplianceBody, products: readonly Product[], facts: readonly ComparisonFact[]): string[] {
  const problems: string[] = [];
  const known = new Set(facts.map((fact) => fact.id));
  for (const rec of body.recommendations) {
    for (const id of rec.factIds ?? []) {
      if (!known.has(id)) problems.push(`추천(${rec.forWhom})이 존재하지 않는 근거 팩트 ID "${id}"를 가리킵니다. 제공된 팩트 ID만 쓰세요`);
    }
  }

  const allowed = new Set<string>();
  for (const fact of facts) numbersIn(fact.text).forEach((n) => allowed.add(n));
  for (const product of products) {
    Object.values(product.specs).forEach((value) => numbersIn(value).forEach((n) => allowed.add(n)));
    if (product.priceKrw !== null) {
      allowed.add(String(product.priceKrw));
      allowed.add(String(product.priceKrw / 10_000)); // "9만원"
    }
  }
  const sentences = [body.verdict, ...body.recommendations.map((rec) => rec.reason)];
  for (const sentence of sentences) {
    for (const match of sentence.matchAll(MEASURED)) {
      const value = match[1]!.replaceAll(",", "");
      if (!allowed.has(value)) problems.push(`"${match[0]}"는 제공된 팩트·스펙·가격에 없는 수치입니다. 데이터에 있는 수치만 쓰세요`);
    }
  }
  return problems;
}

/** 추천이 가리키는 팩트의 수치 문장들. 렌더러가 판단 문장 옆에 코드가 만든 한 줄로 붙인다. */
export function factLinesFor(factIds: readonly string[] | undefined, facts: readonly ComparisonFact[]): string[] {
  return (factIds ?? []).flatMap((id) => {
    const fact = facts.find((candidate) => candidate.id === id);
    return fact === undefined ? [] : [fact.text];
  });
}

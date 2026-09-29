// Fetches every Shopify order that used the discount code and writes
// an anonymised daily aggregate to data/elise-10.json.
//
// Usage:
//   SHOPIFY_STORE=xxx.myshopify.com SHOPIFY_CLIENT_ID=... SHOPIFY_CLIENT_SECRET=... node scripts/fetch.mjs
//     (Dev Dashboard app credentials, exchanged for a 24h token via the client credentials grant)
//   node scripts/fetch.mjs --orders raw-orders.json
//     (aggregate a saved GraphQL result instead of calling the API)

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";

const CODE = "Elise-10";
const TIMEZONE = "Europe/Paris";
const API_VERSION = "2025-07";
const OUTPUT = "data/elise-10.json";

const ORDERS_QUERY = `
  query($after: String, $query: String!) {
    orders(first: 250, after: $after, query: $query, sortKey: CREATED_AT) {
      pageInfo { hasNextPage endCursor }
      nodes {
        createdAt
        cancelledAt
        test
        discountCodes
        subtotalPriceSet { shopMoney { amount } }
        totalDiscountsSet { shopMoney { amount } }
        totalShippingPriceSet { shopMoney { amount } }
        totalTaxSet { shopMoney { amount } }
        totalPriceSet { shopMoney { amount } }
        totalRefundedSet { shopMoney { amount } }
        shippingLine { taxLines { priceSet { shopMoney { amount } } } }
        lineItems(first: 50) {
          nodes { title quantity discountedTotalSet { shopMoney { amount } } }
        }
      }
    }
  }`;

const DISCOUNT_QUERY = `
  query($query: String!) {
    shop { name currencyCode ianaTimezone }
    discountNodes(first: 1, query: $query) {
      nodes {
        discount {
          ... on DiscountCodeBasic { title status summary startsAt endsAt asyncUsageCount }
          ... on DiscountCodeFreeShipping { title status summary startsAt endsAt asyncUsageCount }
          ... on DiscountCodeBxgy { title status summary startsAt endsAt asyncUsageCount }
        }
      }
    }
  }`;

let accessToken = null;

async function getAccessToken(store) {
  if (accessToken) return accessToken;
  const clientId = process.env.SHOPIFY_CLIENT_ID;
  const clientSecret = process.env.SHOPIFY_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error("SHOPIFY_CLIENT_ID and SHOPIFY_CLIENT_SECRET environment variables are required");
  }
  const res = await fetch(`https://${store}/admin/oauth/access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ grant_type: "client_credentials", client_id: clientId, client_secret: clientSecret }),
  });
  if (!res.ok) throw new Error(`Token request failed ${res.status}: ${await res.text()}`);
  const json = await res.json();
  accessToken = json.access_token;
  return accessToken;
}

async function graphql(query, variables) {
  const store = process.env.SHOPIFY_STORE;
  if (!store) throw new Error("SHOPIFY_STORE environment variable is required");
  const token = await getAccessToken(store);
  const res = await fetch(`https://${store}/admin/api/${API_VERSION}/graphql.json`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Accept-Language": "fr-FR", "X-Shopify-Access-Token": token },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) throw new Error(`Shopify API responded ${res.status}: ${await res.text()}`);
  const json = await res.json();
  if (json.errors) throw new Error(`GraphQL errors: ${JSON.stringify(json.errors)}`);
  return json.data;
}

async function fetchAllOrders() {
  const orders = [];
  let after = null;
  do {
    const data = await graphql(ORDERS_QUERY, { after, query: `discount_code:${CODE}` });
    orders.push(...data.orders.nodes);
    after = data.orders.pageInfo.hasNextPage ? data.orders.pageInfo.endCursor : null;
  } while (after);
  return orders;
}

const money = (set) => Number(set?.shopMoney?.amount ?? 0);
const round = (n) => Math.round(n * 100) / 100;

function localDate(iso) {
  // fr-CA formats as YYYY-MM-DD
  return new Intl.DateTimeFormat("fr-CA", { timeZone: TIMEZONE }).format(new Date(iso));
}

export function aggregate(orders) {
  const days = new Map();
  for (const order of orders) {
    if (order.test || order.cancelledAt) continue;
    const usesCode = (order.discountCodes ?? []).some((c) => c.toLowerCase() === CODE.toLowerCase());
    if (!usesCode) continue;

    const date = localDate(order.createdAt);
    const day = days.get(date) ?? {
      date, orders: 0, gross: 0, discount: 0, subtotal: 0, productsHT: 0,
      shipping: 0, tax: 0, total: 0, refunded: 0, products: new Map(),
    };
    const subtotal = money(order.subtotalPriceSet);
    const discount = money(order.totalDiscountsSet);
    const tax = money(order.totalTaxSet);
    const shippingTax = (order.shippingLine?.taxLines ?? []).reduce((s, t) => s + money(t.priceSet), 0);

    day.orders += 1;
    day.gross += subtotal + discount;
    day.discount += discount;
    day.subtotal += subtotal;
    day.productsHT += subtotal - (tax - shippingTax);
    day.shipping += money(order.totalShippingPriceSet);
    day.tax += tax;
    day.total += money(order.totalPriceSet);
    day.refunded += money(order.totalRefundedSet);

    for (const item of order.lineItems?.nodes ?? []) {
      const p = day.products.get(item.title) ?? { title: item.title, qty: 0, revenue: 0 };
      p.qty += item.quantity;
      p.revenue += money(item.discountedTotalSet);
      day.products.set(item.title, p);
    }
    days.set(date, day);
  }

  return [...days.values()]
    .sort((a, b) => a.date.localeCompare(b.date))
    .map((d) => ({
      ...d,
      gross: round(d.gross), discount: round(d.discount), subtotal: round(d.subtotal),
      productsHT: round(d.productsHT), shipping: round(d.shipping), tax: round(d.tax),
      total: round(d.total), refunded: round(d.refunded),
      products: [...d.products.values()].map((p) => ({ ...p, revenue: round(p.revenue) })),
    }));
}

async function main() {
  const fromFile = process.argv.indexOf("--orders");
  let orders, shop, code, source;

  if (fromFile !== -1) {
    const raw = JSON.parse(readFileSync(process.argv[fromFile + 1], "utf8"));
    orders = raw.orders;
    shop = raw.shop;
    code = raw.code;
    source = "manual";
  } else {
    const meta = await graphql(DISCOUNT_QUERY, { query: `title:${CODE}` });
    const discount = meta.discountNodes.nodes[0]?.discount;
    if (!discount) throw new Error(`Discount code ${CODE} not found`);
    shop = meta.shop;
    code = {
      title: discount.title, status: discount.status, summary: discount.summary,
      startsAt: discount.startsAt, endsAt: discount.endsAt, usageCount: discount.asyncUsageCount,
    };
    orders = await fetchAllOrders();
    source = "github-action";
  }

  const output = {
    generatedAt: new Date().toISOString(),
    source,
    shop: { name: shop.name, currency: shop.currencyCode, timezone: shop.ianaTimezone },
    code,
    days: aggregate(orders),
  };
  mkdirSync("data", { recursive: true });
  writeFileSync(OUTPUT, JSON.stringify(output, null, 2) + "\n");
  const totalOrders = output.days.reduce((s, d) => s + d.orders, 0);
  console.log(`Wrote ${OUTPUT}: ${output.days.length} day(s), ${totalOrders} order(s)`);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});

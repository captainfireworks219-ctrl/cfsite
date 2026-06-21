// api/create-checkout.js
//
// Takes a cart of { id, quantity } pairs plus a customer's contact info
// and legal acknowledgements, validates everything server-side, and
// asks Square to create a one-time hosted checkout link for the
// validated order (line items + Indiana sales tax + Indiana public
// safety fee). The browser is redirected to the URL Square returns.
//
// Pricing is never taken from the request body — only from
// products.json, one level up from this file, which is the SAME file
// the website's product grid loads at runtime. There is exactly one
// place prices live; update that file and both the site and checkout
// pick up the change automatically.
//
// ---------------------------------------------------------------
// REQUIRED ENVIRONMENT VARIABLES (set in your hosting provider's
// dashboard — never put these in the HTML/JS file):
//
//   SQUARE_ACCESS_TOKEN   Access token from the Square Developer Dashboard.
//   SQUARE_LOCATION_ID    The Location ID for the store taking payment.
//   SQUARE_ENVIRONMENT    "sandbox" while testing, "production" once
//                         Square has approved your account for live
//                         payments. Defaults to sandbox if unset.
// ---------------------------------------------------------------

const crypto = require('crypto');
const PRODUCTS = require('../products.json');

const SQUARE_BASE_URL =
  process.env.SQUARE_ENVIRONMENT === 'production'
    ? 'https://connect.squareup.com'
    : 'https://connect.squareupsandbox.com';

const MAX_LINE_ITEMS = 50;
const MAX_QTY_PER_ITEM = 99;

// Indiana tax/fee rates. If the state changes either rate, this is the
// only place it needs to change — the checkout modal's displayed
// breakdown is cosmetic; Square's order is what actually gets charged.
const SALES_TAX_PERCENT = '7.0';
const PUBLIC_SAFETY_FEE_PERCENT = '5.0';
const CARD_FEE_PERCENT = '3.0';

// Bundle deals: buy this many items from this category, pay this flat
// price instead of the sum of individual prices. Keep in sync with the
// BUNDLE_DEALS object in the site's own JS (computeCartTotals) — that
// copy only drives the on-screen preview; this one is what actually
// gets charged.
const BUNDLE_DEALS = {
  '200-gram-aerials': { size: 3, price: 50, label: '200 Gram — 3 for $50' },
  '500-gram-10-pack': { size: 10, price: 199, label: '500 Gram — 10 for $199' },
  '500-gram-4-pack': { size: 4, price: 100, label: '500 Gram — 4 for $100' }
};

// Promo codes: percent off, excluding mix & match bundle-deal categories
// entirely when excludeBundleDeals is true. Keep in sync with the
// PROMO_CODES object in index.html — that copy only drives the
// on-screen preview; this one is what actually gets charged.
const PROMO_CODES = {
  LIGHTSFUN: {
    label: 'LIGHTSFUN — 15% off',
    percent: 15,
    excludeBundleDeals: true,
    // Valid through end of day July 2, 2026, Central time — stops
    // working starting July 3.
    expiresAt: '2026-07-03T00:00:00-05:00'
  }
};

const STORE_ADDRESS = '142 W Lincoln Hwy, Schererville, IN 46375';

function findProduct(id) {
  return PRODUCTS.find((p) => p.id === id);
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  try {
    const { items, customer } = req.body || {};

    if (!Array.isArray(items) || items.length === 0) {
      res.status(400).json({ error: 'Cart is empty' });
      return;
    }
    if (items.length > MAX_LINE_ITEMS) {
      res.status(400).json({ error: 'Too many distinct items in cart' });
      return;
    }
    if (!customer?.termsAccepted || !customer?.ageVerified) {
      res.status(400).json({ error: 'Terms acceptance and age verification are required' });
      return;
    }
    if (!process.env.SQUARE_ACCESS_TOKEN || !process.env.SQUARE_LOCATION_ID) {
      res.status(500).json({ error: 'Square credentials are not configured on the server yet' });
      return;
    }

    // ---- Validate every line against the server's own catalog ----
    const lineItems = [];
    const lineMeta = []; // parallel array: { uid, category, qty, price } for discount math below

    for (const rawItem of items) {
      const id = String(rawItem?.id || '');
      const product = findProduct(id);
      if (!product) {
        res.status(400).json({ error: `Unknown product id: ${id}` });
        return;
      }
      if (product.soldOut) {
        res.status(400).json({ error: `${product.name} is currently sold out` });
        return;
      }
      if (product.callForPrice) {
        res.status(400).json({ error: `${product.name} isn't available for online checkout — please call or visit the store for pricing` });
        return;
      }

      const qty = Number(rawItem?.quantity);
      if (!Number.isInteger(qty) || qty < 1 || qty > MAX_QTY_PER_ITEM) {
        res.status(400).json({ error: `Invalid quantity for ${product.name}` });
        return;
      }

      const uid = crypto.randomUUID();
      lineItems.push({
        uid,
        name: product.name,
        quantity: String(qty),
        base_price_money: {
          amount: Math.round(product.price * 100), // from OUR catalog, never the request
          currency: 'USD'
        }
      });
      lineMeta.push({ uid, category: product.category, qty, price: product.price });
    }

    // ---- Bundle deals: buy N from a category, pay a flat price instead
    // of the sum of individual prices. Mirrored exactly in the site's own
    // JS (computeCartTotals) so the checkout modal preview always matches
    // what gets charged here. ----
    const discounts = [];
    // Dollar total of every line item that belongs to ANY bundle-deal
    // category, and the portion of that which did NOT get consumed by a
    // completed bundle this trip (still priced regular — promo-eligible).
    let bundleCategoryTotal = 0;
    let bundleLeftoverTotal = 0;
    Object.entries(BUNDLE_DEALS).forEach(([categoryId, deal]) => {
      const linesInCategory = lineMeta.filter((l) => l.category === categoryId);
      if (linesInCategory.length === 0) return;

      const totalQty = linesInCategory.reduce((s, l) => s + l.qty, 0);
      const groupTotal = linesInCategory.reduce((s, l) => s + l.price * l.qty, 0);
      bundleCategoryTotal += groupTotal;

      const bundles = Math.floor(totalQty / deal.size);
      const avgPrice = groupTotal / totalQty;
      const leftoverQty = totalQty - bundles * deal.size;
      bundleLeftoverTotal += leftoverQty * avgPrice;

      if (bundles === 0) return;

      const discountedGroupTotal = bundles * deal.price + leftoverQty * avgPrice;
      const savings = groupTotal - discountedGroupTotal;
      if (savings <= 0) return;

      const discountUid = crypto.randomUUID();
      discounts.push({
        uid: discountUid,
        name: deal.label,
        amount_money: {
          amount: Math.round(savings * 100),
          currency: 'USD'
        },
        scope: 'LINE_ITEM'
      });

      // Square apportions a fixed LINE_ITEM-scoped discount across every
      // line item that references it, weighted by each item's share of
      // the subtotal — so we just need to tag the right line items.
      linesInCategory.forEach((l) => {
        const targetLine = lineItems.find((li) => li.uid === l.uid);
        targetLine.applied_discounts = [{ discount_uid: discountUid }];
      });
    });

    // ---- Promo code: percent off every dollar still at regular price,
    // including the leftover (non-bundled) portion of mix & match
    // categories, but never the flat-priced bundled portion itself.
    // Applied as a single ORDER-scoped dollar discount rather than
    // tagging individual lines, since Square can't split one line item
    // into "some units at bundle price, some at regular price" for
    // discount purposes — this still produces the exact correct total.
    // Re-validated here from scratch — the browser's claim that a code
    // was applied is never trusted, only the code text itself, looked
    // up against this server's own PROMO_CODES table.
    const rawPromoCode = String(req.body?.promoCode || '').trim().toUpperCase();
    let promoApplied = null;
    if (rawPromoCode) {
      const promo = PROMO_CODES[rawPromoCode];
      if (promo && new Date() < new Date(promo.expiresAt)) {
        const totalLineItemAmount = lineMeta.reduce((s, l) => s + l.price * l.qty, 0);
        const nonBundleTotal = totalLineItemAmount - bundleCategoryTotal;
        const eligibleAmount = promo.excludeBundleDeals
          ? nonBundleTotal + bundleLeftoverTotal
          : totalLineItemAmount;
        const promoDiscountAmount = eligibleAmount * (promo.percent / 100);
        if (promoDiscountAmount > 0.004) {
          const promoUid = crypto.randomUUID();
          discounts.push({
            uid: promoUid,
            name: promo.label,
            type: 'FIXED_AMOUNT',
            amount_money: {
              amount: Math.round(promoDiscountAmount * 100),
              currency: 'USD'
            },
            scope: 'ORDER'
          });
          promoApplied = rawPromoCode;
        }
      }
      // An unknown, expired, or fully-ineligible code is silently
      // ignored rather than failing the whole checkout — worst case the
      // customer just doesn't get the discount they expected, which the
      // front end should already have warned them about before this
      // point.
    }

    const noteParts = [`Pickup at ${STORE_ADDRESS} — call customer to schedule`];
    if (customer?.name) noteParts.push(`Name: ${customer.name}`);
    if (customer?.phone) noteParts.push(`Phone: ${customer.phone}`);
    if (promoApplied) noteParts.push(`Promo code used: ${promoApplied}`);
    noteParts.push('Age 18+ confirmed at checkout');
    noteParts.push('Terms & Conditions accepted at checkout');
    const note = noteParts.join(' | ').slice(0, 500);

    const origin = req.headers.origin || `https://${req.headers.host}`;

    const payload = {
      idempotency_key: crypto.randomUUID(),
      order: {
        location_id: process.env.SQUARE_LOCATION_ID,
        line_items: lineItems,
        discounts,
        taxes: [
          {
            uid: 'IN_SALES_TAX',
            name: 'Indiana Sales Tax',
            percentage: SALES_TAX_PERCENT,
            scope: 'ORDER'
          }
        ],
        service_charges: [
          {
            uid: 'IN_PUBLIC_SAFETY_FEE',
            name: 'Indiana Public Safety Fee',
            percentage: PUBLIC_SAFETY_FEE_PERCENT,
            calculation_phase: 'SUBTOTAL_PHASE',
            taxable: false
          },
          {
            uid: 'CARD_PROCESSING_FEE',
            name: 'Non-Cash Adjustment',
            percentage: CARD_FEE_PERCENT,
            calculation_phase: 'SUBTOTAL_PHASE',
            taxable: false
          }
        ],
        note
      },
      checkout_options: {
        redirect_url: `${origin}/pickup-confirmed.html`
      },
      pre_populated_data: customer?.email ? { buyer_email: customer.email } : undefined
    };

    const squareRes = await fetch(`${SQUARE_BASE_URL}/v2/online-checkout/payment-links`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.SQUARE_ACCESS_TOKEN}`,
        'Square-Version': '2024-08-21'
      },
      body: JSON.stringify(payload)
    });

    const data = await squareRes.json();

    if (!squareRes.ok) {
      console.error('Square API error:', JSON.stringify(data));
      res.status(502).json({ error: 'Square could not create the checkout link' });
      return;
    }

    res.status(200).json({ url: data.payment_link.url });
  } catch (err) {
    console.error('create-checkout error:', err);
    res.status(500).json({ error: 'Server error' });
  }
};

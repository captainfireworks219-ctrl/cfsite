# Captain Fireworks — Square Checkout Setup

This folder is a ready-to-deploy project: the storefront (index.html), the
serverless function that talks to Square (api/create-checkout.js), and the
post-payment confirmation page (pickup-confirmed.html).

## Before anything else
Call Square and confirm consumer fireworks are acceptable on your account.
Square doesn't publish an explicit fireworks ban the way some processors do,
but that's not the same as a guarantee — confirm it before you build a
business around it.

## How pricing security works
The browser never tells the server what anything costs — it only sends
product IDs and quantities. `api/create-checkout.js` looks up the real
price for each ID in `products.json` (at the project root) and computes
the order total itself before asking Square for a checkout link. This
means someone tampering with the request in their browser can't change
what they're charged.

**There is now only one product file.** `products.json` at the project
root is loaded by the website itself (via fetch, to build the product
grid) AND by the checkout backend (to validate prices). Add a firework,
change a price, or add image/video links by editing this one file —
both the storefront and Square checkout pick up the change automatically.
No more keeping two files in sync.

## Sales tax and fees
Indiana Sales Tax (7%) and an Indiana Public Safety Fee (5%) are added
to every order as separate line items on the Square order itself —
Square computes the real total, the checkout modal's breakdown is just
a preview. Both rates are constants near the top of
`api/create-checkout.js` (`SALES_TAX_PERCENT` and
`PUBLIC_SAFETY_FEE_PERCENT`) if either ever needs to change.

## Bundle deals (200 Gram, and 500 Gram 10-pack/4-pack)
Buying enough items from these three categories triggers an automatic
discount: every complete group of 3 (200 Gram), 10, or 4 (500 Gram)
items from that category gets priced at the flat bundle price instead
of the sum of individual prices — any mix of different fireworks within
the category counts toward it, not just identical ones. Leftover items
under a full bundle are still priced normally. This is computed twice
— once in the site's own JS so customers see an accurate preview
before paying, and again independently in `api/create-checkout.js`
using a Square line-item discount, since that second copy is what
actually determines the charge. Both live in a `BUNDLE_DEALS` constant
near the top of each file — keep them in sync if the deal terms ever
change.

## Adding product photos and videos
Click any product's picture on the live site and a popup opens with a
bigger photo and, if one's set, a video right below it — that's already
built and working, just waiting on real photos/videos to show.

Each entry in `products.json` has an `"image"` and a `"video"` field,
both `null` by default.

- **Image:** set it to a direct image URL (ending in .jpg/.png/.webp,
  for example). If you don't have your photos hosted anywhere yet, the
  simplest free option is uploading them to a Google Photos album set
  to "anyone with the link," or Imgur, then copying the direct image
  link.
- **Video:** the easiest option is uploading your video to YouTube
  (it can be set to "Unlisted" so it's not publicly searchable, just
  reachable by link) and pasting that video's URL here.

You don't have to edit the JSON file yourself if you'd rather not —
whenever you have photos and video links ready, send them to me
(upload the photo files directly in chat, and give me the YouTube link
and which product each one belongs to) and I'll drop them into
`products.json` and hand back an updated, ready-to-deploy zip.

## 1. Get your Square credentials
1. Go to the Square Developer Dashboard (developer.squareup.com) and sign in
   with your Square account.
2. Create an Application.
3. Inside that application, grab:
   - Your **Sandbox Access Token** (for testing with fake cards)
   - Your **Sandbox Location ID**
   - Once Square has approved your account for live payments: your
     **Production Access Token** and **Production Location ID**

## 2. Deploy this folder
The easiest free option is Vercel:
1. Create a free account at vercel.com.
2. Install the CLI (`npm i -g vercel`) or just drag-and-drop this folder
   into a new Vercel project from their dashboard.
3. Run `vercel deploy` from inside this folder, or connect it to a GitHub
   repo and let Vercel auto-deploy.

Netlify works the same way (their function folder is `netlify/functions`
instead of `api`, so the file would need to move there — ask me if you'd
like the Netlify-flavored version instead).

## 3. Set environment variables on your host
In your Vercel project settings → Environment Variables, add:

| Variable             | Value                                         |
|-----------------------|-----------------------------------------------|
| SQUARE_ACCESS_TOKEN   | your sandbox token (start here)                |
| SQUARE_LOCATION_ID    | your sandbox location ID                       |
| SQUARE_ENVIRONMENT    | sandbox                                        |

## 4. Test it
Add something to the cart on your deployed site, click "Reserve & Pay
Online," fill out the form, check both the Terms & Conditions and age
boxes (both are required — the form won't submit without them), and
submit. You should land on a real Square checkout page showing your
items plus the 7% sales tax and 5% public safety fee. Use Square's
official test card numbers (in their docs) to simulate a payment —
you'll be redirected to pickup-confirmed.html when it succeeds.

## 5. Go live
Once Square has approved your account and testing looks right, switch the
three environment variables to your **production** token, location ID, and
set SQUARE_ENVIRONMENT to `production`. Redeploy. That's it — no code
changes needed.

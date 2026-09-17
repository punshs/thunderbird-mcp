# Outlook compose formatting regression (0.8.1)

The upstream merge made `isHtml: false` select a native plain-text editor. In this fork that flag historically describes input markup: plain input must be escaped into the Aptos HTML wrapper. The native plain-text editor suppressed that styling and imposed a 72-character editing width, including on replies whose inserted DOM contained an Aptos wrapper.

Restore HTML composition for new messages, replies, forwards and saved drafts regardless of input markup. Keep Thunderbird's Default/OppositeOfDefault forwarding convention to select HTML even when the identity prefers plain text. Existing plain-text windows retain their original mode; the update tool cannot convert them.

Validation: 24 format-selection cases across input flags, identity preferences and message types; full suite 600 passed, 17 skipped, zero failures; lint zero errors with 12 existing warnings. Native Thunderbird 156.0 in an isolated dummy profile confirmed `isHtml: false` creates an HTML editor containing Aptos styling, escaped literal markup, and no 72ch body width. No real messages were modified or sent.

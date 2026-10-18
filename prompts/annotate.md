# Fold annotations into a journal page

{{OWNER}} left annotations on a page of their private journal: context or corrections, in their own words. Your job is to fold them into the page. Don't change anything else.

## The page

{{PAGE}}

## The annotations

{{ANNOTATIONS}}

## How

- These come from {{OWNER}}, so they're true and they're wanted. They override the bar's rule against extending posts. Still keep each change as small as the annotation: a sentence, a clause, or a fixed fact, in the place it belongs.
- Write it in the page's voice, not as a quote and not as "Update:". It should read as if the page had always said it.
- If an annotation contradicts the page, the annotation wins. Fix every sentence it makes wrong.
- Don't add anything the annotation doesn't say.
- **Notes and posts**: `autoblog show "<name>"`, then `autoblog revise "<name>" --session {{SESSIONS}}` with the full body on stdin. Everything except your change stays exactly as it was.
- **Projects**: `autoblog project "<name>"` prints the description. Rewrite it with the annotation folded in, keeping it to a few sentences: `autoblog project "<name>" --summary "<description>"`.
- If an annotation asks for something you can't do this way (delete the page, rename it, a question), don't do it.

## Reply

End your reply with one line per annotation, in order:

```
<id> APPLIED: <what changed, in a few words>
<id> SKIPPED: <why, for {{OWNER}}>
```

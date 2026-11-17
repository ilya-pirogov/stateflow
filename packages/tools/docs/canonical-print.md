# The canonical print of a snapshot
`printStates(target)` (src/print.ts) writes the committed states of a flow as one JSON text (RFC 8259, UTF-8, no whitespace outside strings). Prints are compared byte for byte; another implementation must write the same bytes for the same states. Equal prints come from states the engine holds equal, and the reverse, except as **Not told apart** and **Limits** say.
- **Top**: an object of the target's own enumerable string-keyed props that hold a state instance, by key. A state whose name is an array index (a canonical decimal integer) is written before the others, in numeric order: the names pass through an object, which orders such keys so.
- **Keys**: two positions are written by key, ascending by UTF-16 code units: the states of a target (the top object) and a state's props. Every other plain object is data and keeps its own key order, as ECMAScript's `Object.keys` gives it: keys that are array indices first, ascending, then the others in the order they were written. So a payload, the data of a named result or of a refusal, and an object inside a prop are data. Key order of data is written because a reducer can read it. A key that starts with `$` is written with one more `$` (`$k` as `$$k`), so a key of one `$` always names a form below.
- **Strings and keys**: as ECMAScript `JSON.stringify` writes them: `\"` and `\\`; `\b \f \n \r \t`; any other code unit below U+0020 as `\u00xx`, lowercase hex; a lone surrogate as `\udxxx`, lowercase; every other character as itself, non-ASCII, `/` and U+2028 included.
- **Finite numbers**: as ECMAScript Number::toString: shortest round-trip digits, exponent form from 1e21 and below 1e-6 (`1e+21`, `1e-7`), `-0` as `0`.
- **Sorted lists**: by each element's text, ascending by UTF-16 code units. A map's element is its pair, written as the array `[<key>,<value>]`.

| Value | Written as |
| --- | --- |
| null, a boolean, a string, a finite number | itself |
| NaN, Infinity, -Infinity | `{"$number":"NaN"}`, `{"$number":"Infinity"}`, `{"$number":"-Infinity"}` |
| a bigint | `{"$bigint":"<decimal>"}`, `-` before a negative one |
| undefined, in a prop too (an absent prop is not written) | `{"$undefined":true}` |
| an array | its elements in order; a hole as `{"$hole":true}` |
| a plain object (prototype Object.prototype or null) | an object of its own enumerable string-keyed props, in its own key order |
| a state instance | `{"$state":"<state>.<variant>","props":<an object of its props, by key>}` |
| an Items | `{"$items":[[<key>,<state>],...],"of":"<state>"}`: its pairs in its own order, which sets the order of handler calls, then the name of the definition it holds instances of (`definitionOf`), which an empty one is built again from |
| a Map, a FrozenMap | `{"$map":[[<key>,<value>],...]}`, sorted |
| a Set, a FrozenSet | `{"$set":[...]}`, sorted |
| a DisposableBox | `{"$disposableBox":<n>}`, n the number of the value it wraps. What a box of either kind wraps is never written, a state variant or data included: the engine compares boxes by the identity of what they wrap, and no reducer can read it |
| any other Box | `{"$box":<n>}`, n the number of the value it wraps (Box.equals) |
| a state variant (a function a definition holds for one of its variants; the engine's `isVariant`) | `{"$variant":"<state>.<variant>"}` |
| a symbol, any other function, any other object | `{"$ref":<n>}` |

**Numbers**: per print, from 0: a boxed or referenced value takes the next number when first met while writing, and keeps it. Writing order: keys in the order they are written (by key where **Keys** says so, else the object's own), arrays and Items in order, Map and Set entries in insertion order before sorting, a key before its value. A box of either kind and a direct reference to one value share a number; values are one by SameValueZero.

**Not told apart**: where the engine compares by identity (a Set element, a Map key, a raw Set or Map, a nested state or Items under `equalAnswers: "value"`), the print compares by content. Across two prints, a box or a reference is told apart only by where its number repeats: `Box.of(x)` and `Box.of(y)` in one place print alike, as do two functions that are no variants. NaN prints alike wherever it stands, while the engine holds two NaN props or two NaN map values different (`===`) and two NaN set elements or map keys equal (looked up by SameValueZero).

**Limits**:
- Two states whose data differs only in an object's key order print differently, although no engine comparison tells them apart: a reducer that reads the keys does.
- Numbers inside a set or a map follow insertion order, so two sets or maps that hold the same boxes or references inserted in different orders print differently although the engine holds them equal.
- A state or variant name that holds a dot is not told apart from another split of the same text, as in the engine's own log.
- Data that holds itself makes the print throw.
- Two boxes of NaN share a number although Box.equals holds them different.
- Symbol-keyed props are not written.
- An array's own props other than its elements (the `index` and `input` of a match result) are not written, although the engine compares them.
- Data or states nested deeper than the platform's call stack allows make the print throw; on Node 24's default stack, plain objects 2000 deep print.
- The print is linear in the snapshot's size, except that an entry of a set or map is copied once for each set or map it is nested in, and that sorting compares entries as strings.

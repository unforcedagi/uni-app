# T-45: what Mail will open

Mail comes from anyone. When you press Open on an attachment, the app hands a file to the system, and the system picks
an app for it. So Rust decides first (`crates/uni-core/src/mail/attachment.rs` and `attachment/shape.rs`). A file is
opened only when all of these hold:

1. **Its name** ends in a type on the list: PDF; PNG, JPEG, GIF, WebP, HEIC, BMP; text, Markdown, CSV, calendar,
   contact; RTF; Word, Excel, PowerPoint (`.docx/.xlsx/.pptx`); OpenDocument; Pages, Numbers, Keynote; MP3, AAC, M4A,
   MP4, M4V, MOV, Ogg, Opus, WAV, WebM. Anything else (programs, scripts, web pages, SVG, archives, macro formats) is
   refused before it is fetched.
2. **The declared type** fits the name (or is generic, like `application/octet-stream`). Checked before fetching.
3. **The bytes are one whole, well-formed file of that type.** Each format is walked to its end: PNG chunks and their
   CRCs to `IEND`; JPEG segments and scan data to `EOI`, then nothing but further whole JPEGs (a phone's multi-picture
   or HDR photo); GIF blocks to the
   trailer; a BMP's header (one plane, a width and height, a standard bit count, uncompressed pixels), then its color table,
   pixels (every row) and any embedded color profile, with at most 3 zero bytes between or after them; RIFF (WebP, WAV) and ISO-BMFF (HEIC, MP4, MOV, M4A) sizes to the last byte; Ogg pages to an end-of-stream
   page; MP3 frames, each whole, then only zero padding, an ID3v1 tag or an APEv2 tag whose items fill it exactly; AAC frames to the end; WebM's EBML sizes
   (an element of unknown size, as a browser recorder writes, is walked into); PDF's `startxref` pointing at a
   cross-reference, then `%%EOF`; RTF's braces closing at the end; a zip's end record as the last bytes. A bare signature, a file cut short, or one with something added after its end is
   refused ("it isn't a whole .png file"). TIFF and FLAC are no longer opened, because neither format marks where it
   ends.
4. **Nothing in it runs or loads from outside.** See the next section.

Markdown is saved as `name.md.txt`, so a text editor opens it, not a Markdown viewer that would render HTML in it. Text
of any kind with web-page or script markup (`<script`, `<svg`, `<iframe`, `javascript:` …) is still refused.

## Office and OpenDocument files

Codex round 2 found that the fix-1 check searched a `.docx`'s *compressed* bytes for part names, so an OLE object
stored as `word/embeddings/payload.bin` and referenced by a compressed `oleObject` relationship got through. The brief
offered two fixes: parse the zip properly, or refuse Office files outright. **We parse.** The zip parser had to be
added anyway, because OpenDocument and iWork files are zips too and P3 asks for a valid central directory. With it in
place, the Office rules cost about 100 more lines. Refusing every `.docx`, `.xlsx` and `.pptx` would make
attachments mostly useless in what the owner wants as their main interface. Every rule fails closed: a part it can't read is a
refusal, not a pass.

How it reads them:

- The `zip` crate opens the archive. It is refused if it is not one whole archive: data before it, data after its end
  record, more than 10,000 entries, more than 1 GiB declared, an entry over 10 MiB compressed more than 200 to 1,
  encrypted entries, any compression other than stored or deflate, two entries with one name (ignoring case, as Office
  does), a local header that names a different entry from the central directory, or any gap between entries or before
  the central directory. The only thing allowed there is the entry's own data descriptor, with its CRC and sizes. So
  nothing can hide where a reader walking local headers would find it.
- `[Content_Types].xml` is read first. Then every part that is XML is decompressed (at most 64 MiB a part, 256 MiB a
  file) and parsed with `quick-xml`, whatever it is called and in any Office type. A part is XML if its content type
  says so (its `Override`, or the `Default` for its extension, ending `/xml` or `+xml`: every Office type has
  `openxmlformats` in it, printer settings and fonts too), if it is a `.rels`, or if its first bytes are XML (a
  byte-order mark, UTF-16 without one, or `<` after any whitespace). So a part declared as a picture, or with no content
  type, is still read when it is XML. Part names are compared one way everywhere: the zip's entry names, each
  `Override` part name and each relationship target have their `%20`-style escapes decoded once and are
  lowercased. Two entries that are one part once decoded (`word/my document.xml` and `word/my%20document.xml`) are
  refused, since readers may differ on which one they take. So is a name no part may have (ECMA-376 part 2,
  6.2.2.2): a `%` without two hex digits after it, an escaped `/` or `\` (`word%2Fdocument.xml` is one flat name to
  Office), an escaped letter, digit, `-`, `.`, `_` or `~`, or escapes that don't decode to UTF-8. The
  root relationship must lead to a main document that was parsed as XML in this pass and is declared XML. Codex
  round 4 stored `garbage` as `word/my document.dat`, declared it XML as `/word/my%20document.dat` and pointed the
  root relationship there: fix 3 looked up the override by the escaped name, so it never parsed the part, while
  its main-document check decoded the name and found it present and XML. A part parses as XML only with one root
  element and nothing but XML whitespace outside it; before, `garbage` alone read as an empty document. An empty
  part (LibreOffice writes `Configurations2/accelerator/current.xml` empty) still passes, but is never the main
  document; an OpenDocument's `content.xml` and manifest must be there and not empty. Codex round 3 renamed the main document `word/document.dat` (its override and root relationship following it)
  and put a DDE field in it; fix 2 only read `word/*.xml`, so it got through. A part that isn't UTF-8, declares a DTD, or isn't well-formed is a
  refusal. Character references are resolved, so `&#111;leObject` is read as `oleObject`, just as Word reads it.
- Refused as active:
  - a content type that is macro-enabled, VBA, an OLE object, ActiveX, or an external workbook link (where a
    spreadsheet keeps DDE);
  - a relationship of kind `oleObject`, `package` (an embedded document), `control`/ActiveX, `vbaProject`,
    `attachedTemplate`, `subDocument`, `frame` or `aFChunk`, whatever its target is named;
  - any relationship that points outside the file (`TargetMode="External"`) except a hyperlink. That covers Follina,
    remote templates, and linked images that make Windows send the user's credentials to a file share;
  - a target under `embeddings/`, or one using `mhtml:`;
  - a part named like VBA, ActiveX, an OLE object, or in `embeddings/`;
  - any field, in any XML part, whatever it says: `w:fldSimple`, `w:fldChar`, `w:instrText` or `w:delInstrText`,
    matched without its prefix.

  Fields, round by round. Rounds 1 to 5 read each field's instruction and refused `DDE` and `DDEAUTO`, and each round
  found a way to make the instruction a reader runs differ from the one we read. Fix 1 read one run at a time, and
  the command was split across runs. Codex round 5 split it with a markup-compatibility branch (`DD`, then `x` in a
  `mc:Choice`, then `EAUTO calc`): a reader that picks the empty `mc:Fallback` runs `DDEAUTO calc`, while we joined
  `ddxeauto calc`. Fix 5 refused a field in any part that uses markup compatibility. Codex round 6 put deleted field
  code in between (`DD`, then `<w:del>…<w:delInstrText>x</w:delInstrText>…</w:del>`, then `EAUTO calc`), in a part
  with no markup compatibility. Deleted field code is not part of the current instruction (Microsoft documents it
  as `DeletedFieldCode`), so a reader runs `DDEAUTO calc`. Our first round-6 fix refused a field in a part with
  tracked changes. Its code review found three more ways in, with no tracked changes and no compatibility markup:
  a nested field in the instruction, whose result Word puts into the outer instruction (`DD{QUOTE "E"}AUTO calc`, a
  published way to disguise DDE); text in an ordinary `w:t` run inside the instruction, which LibreOffice adds to
  the command; and hidden text, for a reader that drops it. A second review found simple fields that load from
  outside: `INCLUDEPICTURE`, `INCLUDETEXT` or `LINK` from a file share sends the user's Windows credentials, as a
  linked image does. It also found a soft hyphen splitting a simple `DDEAUTO` into `DD` and `EAUTO`. These reader
  behaviors come from Microsoft's documentation, the reviews and published write-ups. None was tried in Word or
  LibreOffice; each case is refused either way.

  So we stopped reading instructions: a field is refused whatever it says. This was one of the brief's two options,
  and it is the smaller one. The other, refusing a field next to tracked changes, would have left the review's
  three cases open. The fix-5 compatibility rule and the first round-6 tracked-changes rule are now covered by this
  one and were removed. Their payloads stay as regressions. The cost: any Word document with a field is refused.
  Word and LibreOffice declare markup compatibility on almost every part, so since round 5 their fields (a page
  number, a cross-reference, a table of contents, a citation) were already refused. What is newly refused is a field
  from a writer that declares no markup compatibility, and a simple field anywhere (a page number in a footer, for
  example). How many real attachments that adds was not measured. Only Word fields are matched: a slide number
  (`a:fld`) and spreadsheet formulas are not fields in this sense and pass. Since round 7 the refusal says the file
  has "unsupported fields", not "a DDE field", since most refused fields are not DDE. A part with tracked changes or markup compatibility and no field still passes.

  Every attribute with a given name is checked, so a prefixed decoy (`x:Type="…/hyperlink"` next to the real
  `Type="…/oleObject"`) hides nothing.
- OpenDocument: the first entry must be `mimetype`, stored, holding the right type, and the manifest must be present.
  Refused: `Basic/` or `Scripts/` folders, a binary `Object N` part, manifest entries for OLE objects, Basic or
  scripts; in any XML part, an OLE object, applet or plugin element, an event bound to a script (except a
  presentation's page actions), any attribute that is a script or macro URL (`vnd.sun.star.script:`, `macro:`,
  `.uno:`; the LibreLogo exploits and CVE-2018-16858's link) or names a macro (`script:macro-name`, a StarBasic
  language), any DDE element, and any `href` on any element other than a hyperlink that leaves the file (a scheme, an
  absolute path, a Windows file share written `\\host\share`, or a `..` segment anywhere): images, objects, frames,
  linked sections and tables, templates.
- iWork: a whole zip with an `Index/` folder or `index.xml`.

What this refuses that someone might want: a presentation with an embedded chart (its workbook is an embedded
package), a document built on a template stored elsewhere, a slide with a linked online video. The refusal says what was
found and suggests the mail client.

## The cache

Before fix 2, a file was written to `cache/<blob id>/<name>` with ordinary calls, which follow a symlink that is already
there. Now (`write_private`, Unix):

- The mail cache folder is opened with `O_NOFOLLOW | O_DIRECTORY`. A symlink, or anything that isn't a folder, is
  refused. It must be owned by this user. It is made 0700 if it was more open; older builds made it 0755.
- Each open gets a new folder with a random name, created with `mkdirat` relative to the cache folder already open, so
  no path is looked up twice. The file is created with `O_CREAT | O_EXCL | O_NOFOLLOW` as 0600.
- Opens older than a day are cleared on the next open, through the cache folder already opened (`unlinkat`), never by
  path again. Links are removed, never followed.
- The folders above the mail cache folder belong to the system (on Android, `/data/user/0` is itself a symlink), so they
  are not checked. Everything Uni makes from the mail cache folder down is.

What remains: another process running as the same user can still change the file before the viewer reads it. That user
already owns everything the app owns.

## RTF

An embedded object (`\obj…`) is refused, and so is every field but a link to a web or mail address. This fails
closed rather than decoding the instruction as Word would, since every decoder we wrote missed a case. An instruction may
hold only text, plain groups and character
formatting that can't hide or show text (`\rtlch`, `\fcs`, `\af`, `\insrsid`, `\cgrid`, `\b`, `\f`, `\fs`, `\lang`,
`\super`, `\expnd`, `\webhidden` and others Word writes, matched exactly; `\webhidden` hides text only in Word's web
view). `\plain` and `\cs` are allowed only in a file with no `\v` or `\deleted` anywhere: `\plain` would show text
hidden from outside the instruction, and a `\cs` style may be hidden. Anything else is refused: any other control word
(`\uN`, `\bin`, `\v` hidden text, `\deleted`, a destination like `\footnote`, a nested `\field`) and any control
symbol: a `\*` destination, a `\'hh` escape, and since round 7 the ones that stand for a character too (`\\`, `\{`,
`\~` …), since no address the instruction may hold needs one. So a reader shows all of an instruction's text or
none of it.

A field's shape is fixed, so nothing a reader skips can sit among its pieces. `\field` must open its group, and that
group holds only spaces, line breaks, the `\fldedit`-style words that change how a field updates, at most one
instruction group (`{\*\fldinst …}` or `{\fldinst …}`) and at most one result group (`{\fldrslt …}`). A `\fldinst`
anywhere else — in an ignored destination, in the result, with no field around it — is refused. So an instruction is
one group, not pieces a reader joins across destinations it skips. A field nested in another's result is a field of
its own.

What the instruction may say (round 7): nothing at all, or `HYPERLINK` (any case) and one address that starts
`http://`, `https://` or `mailto:`, quoted or not, and nothing else. The address is printable ASCII with no quote or
space. Every other instruction is refused. The check reads the instruction's text as a reader sees it: braces
dropped (plain groups join), spaces, tabs and quotes kept, line breaks dropped. Only spaces separate words; a tab
anywhere in the instruction refuses it. A switch (`\\l`, `\\o`) or a share (`http://\\host\share`) needs a
control symbol, which the instruction can't hold, and a second argument needs a space or a quote.

Codex round 7: rounds 1 to 6 refused an instruction only when it held `dde`, so
`{\field{\*\fldinst INCLUDEPICTURE "file://host/share/a.png"}{\fldrslt x}}` passed. `INCLUDEPICTURE`,
`INCLUDETEXT`, `LINK` and `IMPORT` load a file from where the instruction says; from a share, Windows sends the
user's credentials, as with a linked image in a `.docx`. Rather than list the fields that load or run something,
we list the one field we keep. The brief offered this or refusing every RTF field (as Office files do since round
6). We kept links because RTF has no other way to write one: TextEdit and LibreOffice write a link as a
`HYPERLINK` field, so refusing all fields would refuse almost every RTF they write with a link in it. Word writes its
links with a `{\*\datafield …}` group inside the instruction, which has been refused since round 4, so an RTF
saved from Word with a link stays refused either way. A link reaches the network only when someone clicks it, and
only to a web or mail address. The cost: every other RTF field is refused, including harmless ones: a page number
(`PAGE`), a table of contents (`TOC`, and its `PAGEREF … \h` entries), a date, and a link with a switch (`\l` to a
bookmark, `\o` for a tooltip, `\t` for a target window), to a relative path, or with a space or an escaped
non-ASCII letter in it. An RTF with any of these is refused; it can still be opened from the mail client. How many
real attachments that refuses was not measured.

Codex round 5 put a `\fldinst` in an ignored destination between a field's instruction groups
(`{\field{\*\fldinst DD}{\*\unknown{\*\fldinst x}}{\*\fldinst EAUTO calc}…}`): a reader skips the `\unknown`
destination and joins `DDEAUTO calc`, while fix 4 read every group's text and saw `ddxeauto calc`. Fix 4 refused only
the destinations inside an instruction, not the groups between instructions. Now the field's own group may hold
nothing but its one instruction and one result, so there is no "between instructions" for a destination to hide in.
The cost: a field with more than one instruction group, or anything but `\fldrslt` and the `\fldedit` words beside its
instruction, is refused; such fields are not what Word, LibreOffice or TextEdit write.

Codex round 4 hid DDE behind a destination: `{\*\fldinst DD{\*\unknown x}EAUTO calc}`. A reader skips the
unknown destination and runs `DDEAUTO calc`; fix 3 read its text into the instruction and saw `ddxeautocalc`. Rather
than guess which destinations each reader skips, an instruction now can't hold one. The cost: a hyperlink Word
writes with a `{\*\datafield …}` inside its instruction, or a field nested in another, is refused, and so is a
hyperlink with an escaped accented letter. RTF by mail is rare.

Codex round 3 found that fix 2 started a new scan of the rest of the group at every `fldinst` in the file, text
included, so `{\rtf1 ` and `fldinst ` repeated to 800 KB took about 40 billion steps. Now one pass reads the file's
control words, braces and text once (`shape::rtf`). An instruction is the group that holds a `\fldinst` control word,
read until that group closes. The pass counts the bytes it visits and refuses the file past 3 a byte. It visits about
one, so the bound is a backstop. Control words are matched without case where that refuses more (`\OBJECT`,
`\FLDINST`), and exactly where it skips data. `\BIN20` doesn't skip 20 bytes, because Word parses what follows it. A `\bin` count must be one every reader
reads alike: no sign, no leading zero, at most 10 digits, within 32 bits.

## Not checked

- PDFs, images and recordings are checked for structure, not decoded. The viewer still parses them.
- A WAV whose header sizes are placeholders (some streaming recorders) and an MP3 whose last frame is cut off are
  refused as not whole, though players accept them.
- A DDE formula in a spreadsheet cell is left to Excel, which asks before it runs DDE. So are other things in a
  spreadsheet or document that load from outside but are not fields or relationships to outside: a `WEBSERVICE`
  formula, a data connection (`connections.xml`, a query table's `webPr`), and Word mail-merge settings
  (`w:mailMerge` with a connection string). Found in round 6's third review; not refused, not tried.
- Office parts that aren't XML (pictures, fonts, printer settings) are not read. An embedded font whose obfuscated first byte happens to be `<` would
  be read as XML and refused; that is about one font in 256, in a file that embeds fonts.
- A BMP is refused if it is compressed (RLE, or a JPEG or PNG inside), has a linked color profile, or has anything
  but up to 3 zero bytes before, between or after its pixels and embedded profile. A writer that pads more than that
  is refused.
- Every XML part of an Office file is now read, spreadsheets' and presentations' too, within the limits above (64 MiB
  a part, 256 MiB a file, uncompressed). A spreadsheet export with a sheet over 64 MiB of XML, a few MB zipped, is
  refused as too big to check; fix 2 didn't read sheets, so it passed. And a picture part is XML when it is an SVG.
  An SVG with a `DOCTYPE` (older Illustrator exports have one) makes the document it is in refused, as any DTD does.
- Files Uni saves carry no "downloaded from the internet" mark (Windows Mark-of-the-Web, macOS quarantine), so Office
  on those systems would not open them in Protected View. The preview and Android builds are not affected. It matters if
  a Windows or Mac build ships.

## Tests

- `crates/uni-core/tests/mail_attachment_content.rs`: real files made by LibreOffice, ImageMagick, heif-enc and ffmpeg
  (`tests/fixtures/attachments`) pass. The same files cut short, with bytes added, or altered (Codex's exact bypass, the
  same object under an innocent name, an entity-escaped relationship type, Follina, a remote template, a linked image,
  DDE split across runs, ODF macros and script bindings, UTF-16 and DTD parts, zip limits) are refused.
- `crates/uni-core/tests/mail_attachment.rs`: the real open path over HTTP with a recording opener. It covers Markdown
  saved as `.md.txt` (with `<img onerror>`, upper-case, `<details ontoggle>`, `<video><source onerror>`, `<style>`), a
  private cache, a symlinked cache folder refused, a link planted at fix 1's fixed path never written through, day-old
  opens cleared, and the sample mail's `budget.docx` refused.
- Round 3: `a_dde_field_is_found_whatever_the_word_part_is_called` (Codex's `word/document.dat`, a header with its own
  extension, one declared as a picture, one with no content type, UTF-16 with no byte-order mark, a lost main document,
  fields in spreadsheet and presentation parts); `a_bmp_holds_every_row_of_its_pixels` (Codex's 55-byte cut, every
  fixture cut with its size field updated, header fields, compression, color tables, a linked profile, trailing bytes;
  four more ImageMagick BMPs as fixtures); the RTF case tests above, and `a_large_rtf_is_decided_quickly`. The step
  bound is asserted in the unit test `rtf_is_decided_in_one_bounded_pass` (`attachment.rs`): six payloads of 750 KB
  to 1 MB, each decided in at most 2 steps a byte.
- Round 4: `a_destination_in_a_field_instruction_is_refused` (Codex's sample, `\footnote`, `\v`, `\deleted`, a
  nested field, `{\*\b x}`, text before `\fldinst`; Word-style formatting and plain groups still pass) and
  `escaped_part_names_are_read_as_office_reads_them` (Codex's `word/my document.dat`, the real document under that
  name, a declaration with no root, text after a root or a second root, names that collide once decoded, a
  main document that is the content types, an escape that isn't UTF-8; and from the code review, an empty or
  form-feed main document, `word%2Fdocument.xml`, empty parts in a `.docx` and an `.odt` that pass). The code
  review also added RTF cases: `\plain` under an outer `\v`, a hidden `\cs` style, one field's instruction in two
  groups, `\bin` data before `\fldinst`; Word's table-of-contents formatting and two fields kept apart pass. The
  second review added: a field's first instruction wrapped in a group, `\plain` in a file with `\deleted` text, an
  empty `content.xml` or manifest, `%+5`, a root target `word/document%2Exml`; and these pass: a field nested in a
  hyperlink's result, `\webhidden`, `\cs15` in a hyperlink, `\plain` in a file with nothing hidden. The bounded-pass unit test now walks
  formatting words, nested formatting groups and nested fields, since an instruction stops at the first word
  it doesn't allow.
- Round 5: `a_field_holds_one_instruction_and_one_result` (Codex's `\fldinst` in a destination between instruction
  groups, the same in the result group, a destination or text in the field's own group, a second result or
  instruction, a group that names nothing, an empty group, `\field` that doesn't open its group, an instruction
  with no field, a control symbol in the field group or before a part is named; and these pass: `\fldedit`, line
  breaks and a grouped instruction between the parts, a field in a result, and a space or tab before `\field`,
  `\fldinst` or `\fldrslt`). `a_field_in_a_markup_compatible_part`
  (Codex's `mc:AlternateContent` decoy, a benign field once the part declares the compatibility namespace,
  `mc:ProcessContent` and the namespace under another prefix, the construct element and the `Ignorable` attribute
  each with the namespace left undeclared; and these pass: the pptx fixture and a docx whose only compatibility
  construct wraps no field).
- Round 6: `a_field_in_a_docx_is_refused_whatever_it_says` replaces the DDE-only field test. It runs in parts with no
  markup-compatibility declaration, so no other rule can be what catches them. Refused: the earlier DDE cases;
  Codex's deleted field code in `w:del`; our inserted run in `w:ins` and moved-from run in `w:moveFrom`; from the
  first review, a nested `QUOTE` field, a `w:t` run and a hidden run inside the instruction; from the second, simple
  fields with a soft hyphen in `DDEAUTO`, or `INCLUDEPICTURE`, `INCLUDETEXT` or `LINK` from a file share; a page
  number, simple or complex; and each piece alone (`instrText`, `delInstrText`, a pair of `fldChar`s, an empty
  `fldSimple`, `zz:fldSimple` with an undeclared prefix). These pass: tracked changes, or a compatibility branch,
  with no field, and the pptx fixture. `a_field_in_a_markup_compatible_part` keeps round 5's payloads as
  regressions. From the third review, `opendocument_macros_objects_and_script_bindings_are_refused` refuses an
  image at `\\host\share\a.png`; fix 5 accepted it.
- Round 7: `an_rtf_field_is_refused_unless_it_is_a_web_or_mail_link`. Refused: Codex's `INCLUDEPICTURE` from
  `file://host/share`; `INCLUDETEXT` and `LINK` from a UNC share, `IMPORT`, `INCLUDEPICTURE` from an `https`
  address; the name in odd case or split across formatting groups; `HYPERLINK` to `file:`, to a UNC share, to a
  relative path, with a second address (after a space, or glued on by quotes), with `\o` or `\l`, with a share behind `http://`, with a space in the
  address, joined by a tab or `\~`, or glued to its address; `PAGE`, `PAGEREF … \h` and `DDEAUTO`; and a file-share
  field nested in a link's result. From the code review, a link as Word writes it (with a `\*\datafield` group) and a
  tab after a link, both refused. These pass: a quoted `https` link with a query, an unquoted upper-case one, a
  `mailto:` link split over groups, a field with no instruction and one with an empty instruction. The RTF tests
  from rounds 4 and 5 used `PAGE` as the harmless instruction; they now use a link, so each structural rule is
  still what refuses its case. `a_destination_in_a_field_instruction_is_refused` gains link-shaped payloads (a
  destination, `\v`, `\deleted`, `\'41`, `\u65?`, `\plain` under `\v`, a nested field around a link whose text
  alone would pass), and the round-5 two-instruction case splits a link over its two instructions.
- Each check was disabled in turn, and its test went red each time; where two rules overlap, a case was added that
  only one of them catches. Round 5: the fix-4 code accepts every `a_field_holds_one_instruction_and_one_result`
  payload, and the pre-fix code accepts every `a_field_in_a_markup_compatible_part` payload. Turning off the one
  instruction, the one result, the word list for the field group, the control-symbol rules, the brace-before-naming
  rule, or the "a field opens its group" rule each turns a round-5 RTF case red on a case no other rule catches; and
  turning off the compatibility-element, compatibility-attribute, or compatibility-namespace signal each turns an
  OOXML case red on its own. Round 6: with `refused` set to report rather than panic, the fix-5 code accepts
  Codex's payload, `ins`, `moveFrom`, the three first-review cases, the soft hyphen and the three file-share
  fields, both page numbers and all five lone pieces. Turning off the field rule turns four tests red. Dropping
  `fldChar`, `instrText` or `delInstrText` from it turns that name's lone-piece case red, and dropping `fldSimple`
  turns the simple-field cases red. The fix-1 code fails 11 of the 13 original content tests. Round 3 has two exceptions. An
  Office part's content type and its first bytes overlap on every real file. With sniffing off, the picture-typed
  header goes red. With both off, Codex's `document.dat` goes red. With only content types off, nothing does: an XML
  part a reader can parse always sniffs as XML. And the RTF step bound can't go red while the pass is linear. Putting
  fix 2's per-`fldinst` rescan back in, counted, makes `rtf_is_decided_in_one_bounded_pass` and
  `a_large_rtf_is_decided_quickly` go red. Round 4: the fix-3 code fails both new tests on Codex's exact
  samples; disabling the instruction word list, the `\*` rule, the opening rule, name decoding, the duplicate
  check, the root requirement, the one-root rule, the text-outside-root rule, the UTF-8 escape rule, or the
  parsed-main-part rule each turns a round-4 test red, each on a case no other rule catches. So does each code
  review fix: allowing `\plain` or `\cs`, checking instructions one at a time, letting `\bin` keep `\fldinst`'s
  opening place, dropping `\cgrid`, counting a form feed as whitespace, refusing empty parts, counting an empty
  main document as parsed, and decoding an escaped `/`. And each second-review fix: ignoring `\field`, finding
  nothing hidden, dropping `\webhidden`, any two characters as an escape, decoding escaped unreserved characters,
  letting `content.xml` be empty. Round 7, each change made alone and undone with `git checkout`: going back to the
  `dde` check fails the new test on Codex's payload; accepting any scheme, or a quote inside the address, fails it
  too; dropping spaces from the instruction text fails four RTF tests (every link is refused); allowing two
  instructions, any control word in an instruction, or `\plain` in a file that hides text each fails a round-4 or
  round-5 test on a link-shaped case. Allowing the control symbols that stand for a character again (`\\`, `\~`)
  fails the new test; allowing every control symbol fails three RTF tests. The first round-7 version marked each
  control symbol in the text instead of refusing it; the code review found that indirect, and it was replaced by
  the one rule.

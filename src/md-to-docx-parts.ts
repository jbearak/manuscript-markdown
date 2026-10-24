// The package's smaller parts as export writes them: [Content_Types].xml,
// the relationships, settings, web settings, the font table, the theme and
// the core and app properties. Split out of md-to-docx.ts, whose header's
// invariants hold here too.
import { THEME_MINOR_FONT } from './md-to-docx-styles';
import { escapeXmlAttribute } from './xml-parser';
import { escapeXmlText } from './md-to-docx-citations';
import { getImageContentType } from './image-utils';

interface ContentTypesOptions {
  hasList: boolean;
  hasComments: boolean;
  hasTheme?: boolean;
  hasCustomProps?: boolean;
  hasFootnotes?: boolean;
  hasEndnotes?: boolean;
  hasCommentsExtended?: boolean;
  hasCommentsIds?: boolean;
  hasCommentsExtensible?: boolean;
  hasPeople?: boolean;
  imageExtensions?: Set<string>;
  templateDefaults?: Map<string, string>; // extension -> content type, for the template's headers and footers
  templateOverrides?: Map<string, string>; // part path -> content type, likewise
}

export function contentTypesXml(opts: ContentTypesOptions): string {
  const { hasList, hasComments, hasTheme, hasCustomProps, hasFootnotes, hasEndnotes, hasCommentsExtended, hasCommentsIds, hasCommentsExtensible, hasPeople, imageExtensions, templateDefaults, templateOverrides } = opts;
  let xml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
  xml += '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">\n';
  xml += '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>\n';
  xml += '<Default Extension="xml" ContentType="application/xml"/>\n';
  if (imageExtensions) {
    for (const ext of imageExtensions) {
      const ct = getImageContentType(ext);
      if (ct) xml += '<Default Extension="' + ext + '" ContentType="' + ct + '"/>\n';
    }
  }
  for (const [ext, ct] of templateDefaults ?? []) {
    xml += '<Default Extension="' + escapeXmlAttribute(ext) + '" ContentType="' + escapeXmlAttribute(ct) + '"/>\n';
  }
  xml += '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>\n';
  xml += '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>\n';
  xml += '<Override PartName="/word/settings.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml"/>\n';
  xml += '<Override PartName="/word/webSettings.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.webSettings+xml"/>\n';
  xml += '<Override PartName="/word/fontTable.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.fontTable+xml"/>\n';
  if (hasList) {
    xml += '<Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>\n';
  }
  if (hasComments) {
    xml += '<Override PartName="/word/comments.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml"/>\n';
  }
  if (hasFootnotes) {
    xml += '<Override PartName="/word/footnotes.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footnotes+xml"/>\n';
  }
  if (hasEndnotes) {
    xml += '<Override PartName="/word/endnotes.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.endnotes+xml"/>\n';
  }
  if (hasCommentsExtended) {
    xml += '<Override PartName="/word/commentsExtended.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.commentsExtended+xml"/>\n';
  }
  if (hasCommentsIds) {
    xml += '<Override PartName="/word/commentsIds.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.commentsIds+xml"/>\n';
  }
  if (hasCommentsExtensible) {
    xml += '<Override PartName="/word/commentsExtensible.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.commentsExtensible+xml"/>\n';
  }
  if (hasPeople) {
    xml += '<Override PartName="/word/people.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.people+xml"/>\n';
  }
  if (hasTheme) {
    xml += '<Override PartName="/word/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>\n';
  }
  xml += '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>\n';
  xml += '<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>\n';
  if (hasCustomProps) {
    xml += '<Override PartName="/docProps/custom.xml" ContentType="application/vnd.openxmlformats-officedocument.custom-properties+xml"/>\n';
  }
  for (const [part, ct] of templateOverrides ?? []) {
    xml += '<Override PartName="/' + escapeXmlAttribute(part) + '" ContentType="' + escapeXmlAttribute(ct) + '"/>\n';
  }
  xml += '</Types>';
  return xml;
}

export function relsXml(hasCustomProps?: boolean): string {
  let xml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">\n' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>\n' +
    '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>\n' +
    '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>\n';
  if (hasCustomProps) {
    xml += '<Relationship Id="rId4" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/custom-properties" Target="docProps/custom.xml"/>\n';
  }
  xml += '</Relationships>';
  return xml;
}

export function settingsXml(rsid: string, hasFootnotes?: boolean, hasEndnotes?: boolean, hasThreadedComments?: boolean, evenAndOddHeaders?: boolean): string {
  const ignorable = hasThreadedComments ? 'w14 w15 w16se w16cid w16 w16cex w16sdtdh w16du' : 'w14 w15';
  let xml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    '<w:settings xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml" xmlns:w15="http://schemas.microsoft.com/office/word/2012/wordml" xmlns:w16="http://schemas.microsoft.com/office/word/2018/wordml" xmlns:w16cex="http://schemas.microsoft.com/office/word/2018/wordml/cex" xmlns:w16cid="http://schemas.microsoft.com/office/word/2016/wordml/cid" xmlns:w16du="http://schemas.microsoft.com/office/word/2023/wordml/word16du" xmlns:w16sdtdh="http://schemas.microsoft.com/office/word/2020/wordml/sdtdatahash" xmlns:w16se="http://schemas.microsoft.com/office/word/2015/wordml/symex" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" mc:Ignorable="' + ignorable + '">\n' +
    '<w:zoom w:percent="100"/>\n' +
    '<w:defaultTabStop w:val="720"/>\n' +
    // A template's even-page headers, which Word shows only with this
    (evenAndOddHeaders ? '<w:evenAndOddHeaders/>\n' : '') +
    '<w:characterSpacingControl w:val="doNotCompress"/>\n' +
    // Prevent Word Online from showing hidden text (w:vanish runs used for HTML comments).
    // Without this, Word Desktop may save its "Show Hidden Text" preference into the file,
    // causing Word Online to reveal all vanish-hidden content on subsequent opens.
    '<w:showDraftContent w:val="0"/>\n' +
    '<w:compat>\n' +
    '<w:compatSetting w:name="compatibilityMode" w:uri="http://schemas.microsoft.com/office/word" w:val="15"/>\n' +
    '<w:compatSetting w:name="overrideTableStyleFontSizeAndJustification" w:uri="http://schemas.microsoft.com/office/word" w:val="1"/>\n' +
    '<w:compatSetting w:name="enableOpenTypeFeatures" w:uri="http://schemas.microsoft.com/office/word" w:val="1"/>\n' +
    '<w:compatSetting w:name="doNotFlipMirrorIndents" w:uri="http://schemas.microsoft.com/office/word" w:val="1"/>\n' +
    '<w:compatSetting w:name="differentiateMultirowTableHeaders" w:uri="http://schemas.microsoft.com/office/word" w:val="1"/>\n' +
    '<w:compatSetting w:name="useWord2013TrackBottomHyphenation" w:uri="http://schemas.microsoft.com/office/word" w:val="0"/>\n' +
    '</w:compat>\n' +
    '<m:mathPr>\n' +
    '<m:mathFont m:val="Cambria Math"/>\n' +
    '<m:brkBin m:val="before"/>\n' +
    '<m:brkBinSub m:val="--"/>\n' +
    '<m:smallFrac m:val="0"/>\n' +
    '<m:dispDef/>\n' +
    '<m:lMargin m:val="0"/>\n' +
    '<m:rMargin m:val="0"/>\n' +
    '<m:defJc m:val="centerGroup"/>\n' +
    '<m:wrapIndent m:val="1440"/>\n' +
    '<m:intLim m:val="subSup"/>\n' +
    '<m:naryLim m:val="undOvr"/>\n' +
    '</m:mathPr>\n' +
    '<w:themeFontLang w:val="en-US"/>\n' +
    '<w:clrSchemeMapping w:bg1="light1" w:t1="dark1" w:bg2="light2" w:t2="dark2" w:accent1="accent1" w:accent2="accent2" w:accent3="accent3" w:accent4="accent4" w:accent5="accent5" w:accent6="accent6" w:hyperlink="hyperlink" w:followedHyperlink="followedHyperlink"/>\n' +
    '<w:decimalSymbol w:val="."/>\n' +
    '<w:listSeparator w:val=","/>\n';
  if (hasFootnotes) {
    xml += '<w:footnotePr><w:footnote w:id="-1"/><w:footnote w:id="0"/></w:footnotePr>\n';
  }
  if (hasEndnotes) {
    xml += '<w:endnotePr><w:endnote w:id="-1"/><w:endnote w:id="0"/></w:endnotePr>\n';
  }
  // OneDrive co-authoring compatibility: w14:docId (Word 2010 document identifier)
  // and w15:docId (Word 2013 GUID-based document identifier) MUST be present.
  //
  // Without these, OneDrive's server-side processor treats the file as a legacy
  // document and "upgrades" it for co-authoring — which reassigns all w14:paraId
  // values and strips w15:paraIdParent from commentsExtended.xml, destroying
  // comment threading.  webSettings.xml (registered separately) is also required
  // as part of this minimum viable set.
  //
  // Discovery: raw extension output had correct threading, but OneDrive silently
  // rewrote the file before Word could open it.  Quitting OneDrive made the same
  // file open correctly.  Adding docId + webSettings prevents the rewrite.
  // rsids (Revision Save IDs): Word uses these to track editing sessions.
  // The same rsid is used on paragraph-level w:rsidR attributes (see injectParaIds)
  // so Word treats the document as a coherent single-session output.
  xml += '<w:rsids><w:rsidRoot w:val="' + rsid + '"/><w:rsid w:val="' + rsid + '"/></w:rsids>\n';
  const hexId = Math.floor(Math.random() * 0x7FFFFFFF).toString(16).toUpperCase().padStart(8, '0');
  xml += '<w14:docId w14:val="' + hexId + '"/>\n';
  xml += '<w15:docId w15:val="{' + crypto.randomUUID().toUpperCase() + '}"/>\n';
  xml += '<w15:chartTrackingRefBased/>\n';
  xml += '</w:settings>';
  return xml;
}

/**
 * Minimal webSettings.xml — part of the OneDrive co-authoring compatibility set.
 * Together with w14:docId and w15:docId in settings.xml, this prevents OneDrive
 * from "upgrading" the file and stripping comment threading metadata.
 * See the extended comment in settingsXml() for the full explanation.
 */
export function webSettingsXml(): string {
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    '<w:webSettings xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">\n' +
    '<w:optimizeForBrowser/>\n' +
    '</w:webSettings>';
}

export function fontTableXml(): string {
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    '<w:fonts xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">\n' +
    '<w:font w:name="Calibri"><w:panose1 w:val="020F0502020204030204"/><w:charset w:val="00"/><w:family w:val="swiss"/><w:pitch w:val="variable"/>' +
    '<w:sig w:usb0="E0002AFF" w:usb1="C000247B" w:usb2="00000009" w:usb3="00000000" w:csb0="000001FF" w:csb1="00000000"/></w:font>\n' +
    '<w:font w:name="Times New Roman"><w:panose1 w:val="02020603050405020304"/><w:charset w:val="00"/><w:family w:val="roman"/><w:pitch w:val="variable"/>' +
    '<w:sig w:usb0="E0002EFF" w:usb1="C000785B" w:usb2="00000009" w:usb3="00000000" w:csb0="000001FF" w:csb1="00000000"/></w:font>\n' +
    '<w:font w:name="Consolas"><w:panose1 w:val="020B0609020204030204"/><w:charset w:val="00"/><w:family w:val="modern"/><w:pitch w:val="fixed"/>' +
    '<w:sig w:usb0="E10002FF" w:usb1="4000FCFF" w:usb2="00000009" w:usb3="00000000" w:csb0="0000019F" w:csb1="00000000"/></w:font>\n' +
    '<w:font w:name="Calibri Light"><w:panose1 w:val="020F0302020204030204"/><w:charset w:val="00"/><w:family w:val="swiss"/><w:pitch w:val="variable"/>' +
    '<w:sig w:usb0="E0002AFF" w:usb1="C000247B" w:usb2="00000009" w:usb3="00000000" w:csb0="000001FF" w:csb1="00000000"/></w:font>\n' +
    '</w:fonts>';
}

export function defaultThemeXml(): string {
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    '<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Office Theme">\n' +
    '<a:themeElements>\n' +
    '<a:clrScheme name="Office">\n' +
    '<a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1>\n' +
    '<a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1>\n' +
    '<a:dk2><a:srgbClr val="44546A"/></a:dk2>\n' +
    '<a:lt2><a:srgbClr val="E7E6E6"/></a:lt2>\n' +
    '<a:accent1><a:srgbClr val="4472C4"/></a:accent1>\n' +
    '<a:accent2><a:srgbClr val="ED7D31"/></a:accent2>\n' +
    '<a:accent3><a:srgbClr val="A5A5A5"/></a:accent3>\n' +
    '<a:accent4><a:srgbClr val="FFC000"/></a:accent4>\n' +
    '<a:accent5><a:srgbClr val="5B9BD5"/></a:accent5>\n' +
    '<a:accent6><a:srgbClr val="70AD47"/></a:accent6>\n' +
    '<a:hlink><a:srgbClr val="0563C1"/></a:hlink>\n' +
    '<a:folHlink><a:srgbClr val="954F72"/></a:folHlink>\n' +
    '</a:clrScheme>\n' +
    '<a:fontScheme name="Office">\n' +
    '<a:majorFont><a:latin typeface="Calibri Light"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont>\n' +
    '<a:minorFont><a:latin typeface="' + THEME_MINOR_FONT + '"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont>\n' +
    '</a:fontScheme>\n' +
    '<a:fmtScheme name="Office">\n' +
    '<a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:fillStyleLst>\n' +
    '<a:lnStyleLst><a:ln w="6350"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="12700"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="19050"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln></a:lnStyleLst>\n' +
    '<a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst>\n' +
    '<a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:bgFillStyleLst>\n' +
    '</a:fmtScheme>\n' +
    '</a:themeElements>\n' +
    '</a:theme>';
}

export function corePropsXml(author?: string): string {
  const now = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  let xml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">\n';
  if (author && author.trim()) {
    xml += '<dc:creator>' + escapeXmlText(author) + '</dc:creator>\n';
  }
  xml += '<dcterms:created xsi:type="dcterms:W3CDTF">' + now + '</dcterms:created>\n' +
    '<dcterms:modified xsi:type="dcterms:W3CDTF">' + now + '</dcterms:modified>\n' +
    '</cp:coreProperties>';
  return xml;
}

export function appPropsXml(): string {
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties">\n' +
    '<Application>Manuscript Markup</Application>\n' +
    '</Properties>';
}
interface DocumentRelsOptions {
  relationships: Map<string, string>;
  hasList: boolean;
  hasComments: boolean;
  hasTheme?: boolean;
  hasFootnotes?: boolean;
  hasEndnotes?: boolean;
  hasCommentsExtended?: boolean;
  hasCommentsIds?: boolean;
  hasCommentsExtensible?: boolean;
  hasPeople?: boolean;
  imageRelationships?: Map<string, { rId: string; mediaPath: string }>;
  templateRelationships?: Array<{ type: string; target: string; external: boolean }>; // rId1 to rIdN, the template's headers' and footers'
}

export function documentRelsXml(opts: DocumentRelsOptions): string {
  const { relationships, hasList, hasComments, hasTheme, hasFootnotes, hasEndnotes, hasCommentsExtended, hasCommentsIds, hasCommentsExtensible, hasPeople, imageRelationships, templateRelationships } = opts;
  let xml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
  xml += '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">\n';
  // All rIds must be sequential with no gaps — see dirty-flag invariant #6.
  let nextFixed = 1;
  for (const relationship of templateRelationships ?? []) {
    xml += '<Relationship Id="rId' + nextFixed + '" Type="' + escapeXmlAttribute(relationship.type) + '" Target="' + escapeXmlAttribute(relationship.target) + '"' + (relationship.external ? ' TargetMode="External"' : '') + '/>\n';
    nextFixed++;
  }
  xml += '<Relationship Id="rId' + nextFixed + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>\n';
  nextFixed++;

  if (hasList) {
    xml += '<Relationship Id="rId' + nextFixed + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/>\n';
    nextFixed++;
  }

  if (hasComments) {
    xml += '<Relationship Id="rId' + nextFixed + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments" Target="comments.xml"/>\n';
    nextFixed++;
  }
  if (hasFootnotes) {
    xml += '<Relationship Id="rId' + nextFixed + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footnotes" Target="footnotes.xml"/>\n';
    nextFixed++;
  }
  if (hasEndnotes) {
    xml += '<Relationship Id="rId' + nextFixed + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/endnotes" Target="endnotes.xml"/>\n';
    nextFixed++;
  }
  if (hasCommentsExtended) {
    xml += '<Relationship Id="rId' + nextFixed + '" Type="http://schemas.microsoft.com/office/2011/relationships/commentsExtended" Target="commentsExtended.xml"/>\n';
    nextFixed++;
  }
  if (hasCommentsIds) {
    xml += '<Relationship Id="rId' + nextFixed + '" Type="http://schemas.microsoft.com/office/2016/09/relationships/commentsIds" Target="commentsIds.xml"/>\n';
    nextFixed++;
  }
  if (hasCommentsExtensible) {
    xml += '<Relationship Id="rId' + nextFixed + '" Type="http://schemas.microsoft.com/office/2018/08/relationships/commentsExtensible" Target="commentsExtensible.xml"/>\n';
    nextFixed++;
  }
  if (hasPeople) {
    xml += '<Relationship Id="rId' + nextFixed + '" Type="http://schemas.microsoft.com/office/2011/relationships/people" Target="people.xml"/>\n';
    nextFixed++;
  }
  if (hasTheme) {
    xml += '<Relationship Id="rId' + nextFixed + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="theme/theme1.xml"/>\n';
    nextFixed++;
  }
  xml += '<Relationship Id="rId' + nextFixed + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/settings" Target="settings.xml"/>\n';
  nextFixed++;
  xml += '<Relationship Id="rId' + nextFixed + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/webSettings" Target="webSettings.xml"/>\n';
  nextFixed++;
  xml += '<Relationship Id="rId' + nextFixed + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/fontTable" Target="fontTable.xml"/>\n';

  for (const [url, relId] of relationships) {
    xml += '<Relationship Id="' + relId + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="' + escapeXmlAttribute(url) + '" TargetMode="External"/>\n';
  }

  if (imageRelationships) {
    for (const [, entry] of imageRelationships) {
      xml += '<Relationship Id="' + entry.rId + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="' + entry.mediaPath + '"/>\n';
    }
  }

  xml += '</Relationships>';
  return xml;
}

export function noteRelsXml(
  relationships: Map<string, string>,
  imageRelationships: Map<string, { rId: string; mediaPath: string }>,
): string {
  let xml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
  xml += '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">\n';
  for (const [url, relId] of relationships) {
    xml += '<Relationship Id="' + relId + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="' + escapeXmlAttribute(url) + '" TargetMode="External"/>\n';
  }
  for (const [, entry] of imageRelationships) {
    xml += '<Relationship Id="' + entry.rId + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="' + entry.mediaPath + '"/>\n';
  }
  xml += '</Relationships>';
  return xml;
}

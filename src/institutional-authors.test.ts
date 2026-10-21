import { describe, it, expect } from 'bun:test';
import {
  parseAuthors,
  splitAuthorString,
  buildItemData,
  generateFallbackText,
  generateCitation,
} from './md-to-docx-citations';
import {
  generateBibTeX,
  buildCitationKeyMap,
  mapCSLTypeToBibtex,
  ZoteroCitation,
  CitationMetadata,
} from './converter';
import { BibtexEntry, parseBibtex } from './bibtex-parser';
import { convertMdToDocx } from './md-to-docx';
import { convertDocx } from './converter';

// ---------- splitAuthorString ----------

describe('splitAuthorString', () => {
  it('splits plain personal authors on " and "', () => {
    expect(splitAuthorString('Smith, John and Doe, Jane')).toEqual([
      'Smith, John',
      'Doe, Jane',
    ]);
  });

  it('does not split inside braces', () => {
    expect(splitAuthorString('{Smith and Associates}')).toEqual([
      '{Smith and Associates}',
    ]);
  });

  it('handles mixed personal and institutional authors', () => {
    expect(splitAuthorString('Smith, John and {World Health Organization} and Doe, Jane')).toEqual([
      'Smith, John',
      '{World Health Organization}',
      'Doe, Jane',
    ]);
  });

  it('handles single author', () => {
    expect(splitAuthorString('Smith, John')).toEqual(['Smith, John']);
  });

  it('handles nested braces', () => {
    expect(splitAuthorString('{Centers for Disease Control and Prevention}')).toEqual([
      '{Centers for Disease Control and Prevention}',
    ]);
  });
});

// ---------- parseAuthors ----------

describe('parseAuthors', () => {
  it('parses "Family, Given" format', () => {
    const result = parseAuthors('Smith, John');
    expect(result).toEqual([{ family: 'Smith', given: 'John' }]);
  });

  it('parses "Given Family" format', () => {
    const result = parseAuthors('John Smith');
    expect(result).toEqual([{ family: 'Smith', given: 'John' }]);
  });

  it('parses institutional author in braces', () => {
    const result = parseAuthors('{World Health Organization}');
    expect(result).toEqual([{ literal: 'World Health Organization' }]);
  });

  it('parses mixed personal and institutional authors', () => {
    const result = parseAuthors('Smith, John and {World Health Organization}');
    expect(result).toEqual([
      { family: 'Smith', given: 'John' },
      { literal: 'World Health Organization' },
    ]);
  });

  it('handles "and" inside braces for institutional author', () => {
    const result = parseAuthors('{Centers for Disease Control and Prevention} and Smith, John');
    expect(result).toEqual([
      { literal: 'Centers for Disease Control and Prevention' },
      { family: 'Smith', given: 'John' },
    ]);
  });

  it('handles single-word author', () => {
    const result = parseAuthors('Aristotle');
    expect(result).toEqual([{ family: 'Aristotle' }]);
  });
});

// ---------- buildItemData ----------

describe('buildItemData with additional fields', () => {
  it('maps editor field using parseAuthors', () => {
    const entry: BibtexEntry = {
      type: 'incollection',
      key: 'test',
      fields: new Map([
        ['title', 'A Chapter'],
        ['editor', 'Editor, First and {Editorial Board}'],
      ]),
    };
    const data = buildItemData(entry);
    expect(data.editor).toEqual([
      { family: 'Editor', given: 'First' },
      { literal: 'Editorial Board' },
    ]);
  });

  it('maps publisher, address, url, isbn, issn', () => {
    const entry: BibtexEntry = {
      type: 'book',
      key: 'test',
      fields: new Map([
        ['publisher', 'MIT Press'],
        ['address', 'Cambridge, MA'],
        ['url', 'https://example.com'],
        ['isbn', '978-0-123456-78-9'],
        ['issn', '1234-5678'],
      ]),
    };
    const data = buildItemData(entry);
    expect(data.publisher).toBe('MIT Press');
    expect(data['publisher-place']).toBe('Cambridge, MA');
    expect(data.URL).toBe('https://example.com');
    expect(data.ISBN).toBe('978-0-123456-78-9');
    expect(data.ISSN).toBe('1234-5678');
  });

  it('maps number to issue, edition, abstract, note, series', () => {
    const entry: BibtexEntry = {
      type: 'article',
      key: 'test',
      fields: new Map([
        ['number', '3'],
        ['edition', '2nd'],
        ['abstract', 'An abstract.'],
        ['note', 'A note.'],
        ['series', 'Lecture Notes'],
      ]),
    };
    const data = buildItemData(entry);
    expect(data.issue).toBe('3');
    expect(data.edition).toBe('2nd');
    expect(data.abstract).toBe('An abstract.');
    expect(data.note).toBe('A note.');
    expect(data['collection-title']).toBe('Lecture Notes');
  });

  it('maps booktitle to container-title when journal absent', () => {
    const entry: BibtexEntry = {
      type: 'incollection',
      key: 'test',
      fields: new Map([
        ['booktitle', 'Proceedings of Something'],
      ]),
    };
    const data = buildItemData(entry);
    expect(data['container-title']).toBe('Proceedings of Something');
  });

  it('does not override container-title when journal present', () => {
    const entry: BibtexEntry = {
      type: 'article',
      key: 'test',
      fields: new Map([
        ['journal', 'Some Journal'],
        ['booktitle', 'Should Not Appear'],
      ]),
    };
    const data = buildItemData(entry);
    expect(data['container-title']).toBe('Some Journal');
  });

  it('sets genre for mastersthesis entries', () => {
    const entry: BibtexEntry = {
      type: 'mastersthesis',
      key: 'test',
      fields: new Map([['title', 'My Thesis'], ['year', '2020']]),
    };
    const data = buildItemData(entry);
    expect(data.type).toBe('thesis');
    expect(data.genre).toBe("Master's thesis");
  });

  it('sets genre for phdthesis entries', () => {
    const entry: BibtexEntry = {
      type: 'phdthesis',
      key: 'test',
      fields: new Map([['title', 'My Dissertation'], ['year', '2020']]),
    };
    const data = buildItemData(entry);
    expect(data.type).toBe('thesis');
    expect(data.genre).toBe('PhD thesis');
  });

  it('does not set genre for non-thesis entries', () => {
    const entry: BibtexEntry = {
      type: 'article',
      key: 'test',
      fields: new Map([['title', 'A Paper']]),
    };
    const data = buildItemData(entry);
    expect(data.genre).toBeUndefined();
  });

  it('maps institutional author to CSL literal', () => {
    const entry: BibtexEntry = {
      type: 'article',
      key: 'who2020',
      fields: new Map([
        ['author', '{World Health Organization}'],
        ['year', '2020'],
        ['title', 'Test Report'],
      ]),
    };
    const data = buildItemData(entry);
    expect(data.author).toEqual([{ literal: 'World Health Organization' }]);
  });
});

// ---------- generateBibTeX ----------

describe('generateBibTeX with institutional authors and additional fields', () => {
  it('emits literal authors as braced names', () => {
    const citations: ZoteroCitation[] = [{
      plainCitation: '(WHO 2020)',
      items: [{
        authors: [{ literal: 'World Health Organization' }],
        title: 'Test Report', year: '2020', journal: '', volume: '',
        pages: '', doi: '', type: 'report',
        fullItemData: {},
      }],
    }];
    const keyMap = buildCitationKeyMap(citations);
    const bib = generateBibTeX(citations, keyMap);
    expect(bib).toContain('author = {{World Health Organization}}');
  });

  it('emits mixed personal and literal authors', () => {
    const citations: ZoteroCitation[] = [{
      plainCitation: '(Smith et al.)',
      items: [{
        authors: [
          { family: 'Smith', given: 'John' },
          { literal: 'Centers for Disease Control and Prevention' },
        ],
        title: 'Test', year: '2020', journal: 'J', volume: '1',
        pages: '', doi: '', type: 'article-journal',
        fullItemData: {},
      }],
    }];
    const keyMap = buildCitationKeyMap(citations);
    const bib = generateBibTeX(citations, keyMap);
    expect(bib).toContain('Smith, John and {Centers for Disease Control and Prevention}');
  });

  it('emits additional fields from fullItemData', () => {
    const citations: ZoteroCitation[] = [{
      plainCitation: '(Test)',
      items: [{
        authors: [{ family: 'Test', given: 'A' }],
        title: 'Test Title', year: '2020', journal: '', volume: '',
        pages: '', doi: '', type: 'book',
        fullItemData: {
          publisher: 'MIT Press',
          'publisher-place': 'Cambridge',
          'URL': 'https://example.com',
          'ISBN': '978-0-123',
          'ISSN': '1234-5678',
          issue: '3',
          edition: '2nd',
          abstract: 'An abstract.',
          note: 'A note.',
          'collection-title': 'Lecture Notes',
          status: 'in press',
        },
      }],
    }];
    const keyMap = buildCitationKeyMap(citations);
    const bib = generateBibTeX(citations, keyMap);
    expect(bib).toContain('publisher = {MIT Press}');
    expect(bib).toContain('address = {Cambridge}');
    expect(bib).toContain('url = {https://example.com}');
    expect(bib).toContain('isbn = {978-0-123}');
    expect(bib).toContain('issn = {1234-5678}');
    expect(bib).toContain('number = {3}');
    expect(bib).toContain('edition = {2nd}');
    expect(bib).toContain('abstract = {An abstract.}');
    expect(bib).toContain('note = {A note.}');
    expect(bib).toContain('series = {Lecture Notes}');
    expect(bib).toContain('pubstate = {in press}');
  });

  // Which export would read as the state the key names, as in press
  it.each([
    ['inpress', '{{inpress}}'],
    ['to appear inpress', '{{to appear inpress}}'],
    ['in press', '{in press}'],
    ['inpress,', '{inpress,}'],
    ['<span class="nocase">inpress</span>', '{{{inpress}}}'],
  ])('writes a status of %j that holds one of biblatex\'s keys in a group around the whole pubstate, which export reads back as it was', (status, written) => {
    const citations: ZoteroCitation[] = [{
      plainCitation: '(Test)',
      items: [{
        authors: [{ family: 'Test', given: 'A' }],
        title: 'T', year: '2020', journal: '', volume: '',
        pages: '', doi: '', type: 'article-journal',
        fullItemData: { status },
      }],
    }];
    const bib = generateBibTeX(citations, buildCitationKeyMap(citations));
    expect(bib).toContain('pubstate = ' + written + ',');
    const [entry] = parseBibtex(bib).values();
    expect(buildItemData(entry).status).toBe(status);
  });

  it('preserves URL and DOI verbatim without LaTeX escaping', () => {
    const citations: ZoteroCitation[] = [{
      plainCitation: '(Test)',
      items: [{
        authors: [{ family: 'Test', given: 'A' }],
        title: 'Test', year: '2020', journal: 'J', volume: '1',
        pages: '', doi: '10.1000/some_thing#ref', type: 'article-journal',
        fullItemData: {
          'URL': 'https://example.com/path_to/doc#section?q=100%25',
          'ISBN': '978-0-12-345678-9',
        },
      }],
    }];
    const keyMap = buildCitationKeyMap(citations);
    const bib = generateBibTeX(citations, keyMap);
    expect(bib).toContain('doi = {10.1000/some_thing#ref}');
    expect(bib).toContain('url = {https://example.com/path_to/doc#section?q=100%25}');
    expect(bib).toContain('isbn = {978-0-12-345678-9}');
  });

  it('emits numeric CSL field values (e.g. edition, issue)', () => {
    const citations: ZoteroCitation[] = [{
      plainCitation: '(Test)',
      items: [{
        authors: [{ family: 'Test', given: 'A' }],
        title: 'Test Title', year: '2020', journal: 'J', volume: '1',
        pages: '', doi: '', type: 'article-journal',
        fullItemData: {
          edition: 3,
          issue: 2,
        },
      }],
    }];
    const keyMap = buildCitationKeyMap(citations);
    const bib = generateBibTeX(citations, keyMap);
    expect(bib).toContain('edition = {3}');
    expect(bib).toContain('number = {2}');
  });

  it('emits editor from fullItemData', () => {
    const citations: ZoteroCitation[] = [{
      plainCitation: '(Test)',
      items: [{
        authors: [{ family: 'Author', given: 'A' }],
        title: 'Chapter', year: '2020', journal: 'Book Title', volume: '',
        pages: '', doi: '', type: 'chapter',
        fullItemData: {
          editor: [
            { family: 'Editor', given: 'B' },
            { literal: 'Editorial Board' },
          ],
        },
      }],
    }];
    const keyMap = buildCitationKeyMap(citations);
    const bib = generateBibTeX(citations, keyMap);
    expect(bib).toContain('editor = {Editor, B and {Editorial Board}}');
  });

  it('emits container-title as booktitle for chapter types', () => {
    const citations: ZoteroCitation[] = [{
      plainCitation: '(Test)',
      items: [{
        authors: [{ family: 'Test', given: 'A' }],
        title: 'Chapter Title', year: '2020', journal: 'Book Title', volume: '',
        pages: '1-20', doi: '', type: 'chapter',
        fullItemData: {},
      }],
    }];
    const keyMap = buildCitationKeyMap(citations);
    const bib = generateBibTeX(citations, keyMap);
    expect(bib).toContain('booktitle = {Book Title}');
    expect(bib).not.toContain('journal');
  });

  it('emits container-title as journal for article types', () => {
    const citations: ZoteroCitation[] = [{
      plainCitation: '(Test)',
      items: [{
        authors: [{ family: 'Test', given: 'A' }],
        title: 'Article Title', year: '2020', journal: 'Some Journal', volume: '1',
        pages: '1-20', doi: '', type: 'article-journal',
        fullItemData: {},
      }],
    }];
    const keyMap = buildCitationKeyMap(citations);
    const bib = generateBibTeX(citations, keyMap);
    expect(bib).toContain('journal = {Some Journal}');
    expect(bib).not.toContain('booktitle');
  });
});

// ---------- generateBibTeX: institution field ----------

describe('generateBibTeX institution handling', () => {
  it('emits publisher as institution for techreport (Zotero path)', () => {
    const citations: ZoteroCitation[] = [{
      plainCitation: '(NCHS 2014)',
      items: [{
        authors: [{ literal: 'National Center for Health Statistics' }],
        title: 'National Survey', year: '2014', journal: '', volume: '',
        pages: '', doi: '', type: 'report',
        fullItemData: {
          publisher: 'National Center for Health Statistics',
        },
      }],
    }];
    const keyMap = buildCitationKeyMap(citations);
    const bib = generateBibTeX(citations, keyMap);
    expect(bib).toContain('institution = {National Center for Health Statistics}');
    expect(bib).not.toContain('publisher');
  });

  it('prefers x-institution over publisher for techreport', () => {
    const citations: ZoteroCitation[] = [{
      plainCitation: '(NCHS 2014)',
      items: [{
        authors: [{ literal: 'National Center for Health Statistics' }],
        title: 'National Survey', year: '2014', journal: '', volume: '',
        pages: '', doi: '', type: 'report',
        fullItemData: {
          publisher: 'US Government',
          'x-institution': 'National Center for Health Statistics',
        },
      }],
    }];
    const keyMap = buildCitationKeyMap(citations);
    const bib = generateBibTeX(citations, keyMap);
    expect(bib).toContain('institution = {National Center for Health Statistics}');
    expect(bib).toContain('publisher = {US Government}');
  });

  it('does not emit institution for non-techreport types', () => {
    const citations: ZoteroCitation[] = [{
      plainCitation: '(Test 2020)',
      items: [{
        authors: [{ family: 'Test', given: 'A' }],
        title: 'A Book', year: '2020', journal: '', volume: '',
        pages: '', doi: '', type: 'book',
        fullItemData: {
          publisher: 'MIT Press',
        },
      }],
    }];
    const keyMap = buildCitationKeyMap(citations);
    const bib = generateBibTeX(citations, keyMap);
    expect(bib).toContain('publisher = {MIT Press}');
    expect(bib).not.toContain('institution');
  });
});

// ---------- mapCSLTypeToBibtex ----------

describe('mapCSLTypeToBibtex', () => {
  it('maps article-journal to article', () => {
    expect(mapCSLTypeToBibtex('article-journal')).toBe('article');
  });

  it('maps article-magazine to article', () => {
    expect(mapCSLTypeToBibtex('article-magazine')).toBe('article');
  });

  it('maps article-newspaper to article', () => {
    expect(mapCSLTypeToBibtex('article-newspaper')).toBe('article');
  });

  it('maps book to book', () => {
    expect(mapCSLTypeToBibtex('book')).toBe('book');
  });

  it('maps chapter to incollection', () => {
    expect(mapCSLTypeToBibtex('chapter')).toBe('incollection');
  });

  it('maps paper-conference to inproceedings', () => {
    expect(mapCSLTypeToBibtex('paper-conference')).toBe('inproceedings');
  });

  it('maps thesis to phdthesis by default', () => {
    expect(mapCSLTypeToBibtex('thesis')).toBe('phdthesis');
  });

  it('maps thesis with master genre to mastersthesis', () => {
    expect(mapCSLTypeToBibtex('thesis', "Master's thesis")).toBe('mastersthesis');
    expect(mapCSLTypeToBibtex('thesis', 'master')).toBe('mastersthesis');
  });

  it('maps thesis with PhD genre to phdthesis', () => {
    expect(mapCSLTypeToBibtex('thesis', 'PhD dissertation')).toBe('phdthesis');
  });

  it('maps report to techreport', () => {
    expect(mapCSLTypeToBibtex('report')).toBe('techreport');
  });

  it('maps unknown types to misc', () => {
    expect(mapCSLTypeToBibtex('webpage')).toBe('misc');
    expect(mapCSLTypeToBibtex('dataset')).toBe('misc');
  });
});

// ---------- getSurname (via buildCitationKeyMap) ----------

describe('getSurname with literal author', () => {
  it('uses literal name for citation key generation', () => {
    const citations: ZoteroCitation[] = [{
      plainCitation: '(WHO 2020)',
      items: [{
        authors: [{ literal: 'World Health Organization' }],
        title: 'Report Title', year: '2020', journal: '', volume: '',
        pages: '', doi: '', type: 'report',
        fullItemData: {},
      }],
    }];
    const keyMap = buildCitationKeyMap(citations);
    // Key should start with the literal name (cleaned)
    const key = [...keyMap.values()][0];
    expect(key).toContain('worldhealthorganization');
  });
});

// ---------- buildItemData with institution fallback ----------

describe('buildItemData with institution fallback (no author)', () => {
  it('maps institution to CSL literal author for techreport', () => {
    const entry: BibtexEntry = {
      type: 'techreport',
      key: 'nchs2014',
      fields: new Map([
        ['institution', 'National Center for Health Statistics'],
        ['title', 'National Survey of Family Growth'],
        ['year', '2014'],
      ]),
    };
    const data = buildItemData(entry);
    expect(data.author).toEqual([{ literal: 'National Center for Health Statistics' }]);
    expect(data['x-institution']).toBe('National Center for Health Statistics');
  });

  it('prefers author over institution when both present', () => {
    const entry: BibtexEntry = {
      type: 'techreport',
      key: 'test2020',
      fields: new Map([
        ['author', 'Smith, John'],
        ['institution', 'Some Institute'],
        ['year', '2020'],
      ]),
    };
    const data = buildItemData(entry);
    expect(data.author).toEqual([{ family: 'Smith', given: 'John' }]);
    expect(data['x-institution']).toBe('Some Institute');
  });

  it('does not set author when neither author nor institution present', () => {
    const entry: BibtexEntry = {
      type: 'techreport',
      key: 'anon2020',
      fields: new Map([
        ['title', 'Anonymous Report'],
        ['year', '2020'],
      ]),
    };
    const data = buildItemData(entry);
    expect(data.author).toBeUndefined();
  });
});

// ---------- generateFallbackText ----------

describe('generateFallbackText with institutional author', () => {
  it('uses full institutional name in fallback text', () => {
    const entries = new Map<string, BibtexEntry>();
    entries.set('who2020', {
      type: 'report',
      key: 'who2020',
      fields: new Map([
        ['author', '{World Health Organization}'],
        ['year', '2020'],
      ]),
    });
    const result = generateFallbackText(['who2020'], entries);
    expect(result).toBe('(World Health Organization 2020)');
  });

  it('uses institutional name from mixed author list', () => {
    const entries = new Map<string, BibtexEntry>();
    entries.set('cdc2021', {
      type: 'report',
      key: 'cdc2021',
      fields: new Map([
        ['author', '{Centers for Disease Control and Prevention}'],
        ['year', '2021'],
      ]),
    });
    const result = generateFallbackText(['cdc2021'], entries);
    expect(result).toBe('(Centers for Disease Control and Prevention 2021)');
  });
});

describe('generateFallbackText with institution fallback (no author)', () => {
  it('uses institution name instead of citekey', () => {
    const entries = new Map<string, BibtexEntry>();
    entries.set('nchs2014', {
      type: 'techreport',
      key: 'nchs2014',
      fields: new Map([
        ['institution', 'National Center for Health Statistics'],
        ['year', '2014'],
      ]),
    });
    const result = generateFallbackText(['nchs2014'], entries);
    expect(result).toBe('(National Center for Health Statistics 2014)');
  });

  it('falls back to citekey when neither author nor institution', () => {
    const entries = new Map<string, BibtexEntry>();
    entries.set('anon2020', {
      type: 'techreport',
      key: 'anon2020',
      fields: new Map([
        ['year', '2020'],
      ]),
    });
    const result = generateFallbackText(['anon2020'], entries);
    expect(result).toBe('(anon2020 2020)');
  });
});

// ---------- generateCitation with institutional author ----------

describe('generateCitation with institutional author', () => {
  it('produces field code with institutional author', () => {
    const entries = new Map<string, BibtexEntry>();
    entries.set('who2020', {
      type: 'report',
      key: 'who2020',
      fields: new Map([
        ['author', '{World Health Organization}'],
        ['year', '2020'],
        ['title', 'Guidelines'],
      ]),
    });

    const run = { keys: ['who2020'], text: 'who2020' };
    const result = generateCitation(run, entries);

    expect(result.xml).toContain('ZOTERO_ITEM CSL_CITATION');
    // Should have literal field in the JSON
    expect(result.xml).toContain('literal');
    expect(result.xml).toContain('World Health Organization');
    expect(result.xml).toContain('(World Health Organization 2020)');
  });
});

// ---------- End-to-end roundtrip ----------

describe('roundtrip: institutional author + extra fields', () => {
  it('preserves institutional author through MD → DOCX → MD', async () => {
    const md = `Text with a citation [@who2020].
`;
    const bib = `@techreport{who2020,
  author = {{World Health Organization}},
  title = {{Global Health Report}},
  year = {2020},
  publisher = {WHO Press},
  address = {Geneva},
  url = {https://www.who.int/report},
  note = {Important report},
}`;

    const docxResult = await convertMdToDocx(md, { bibtex: bib });
    const result = await convertDocx(docxResult.docx);

    // Institutional author should round-trip
    expect(result.bibtex).toContain('{World Health Organization}');
    // Extra fields should survive
    expect(result.bibtex).toContain('publisher = {WHO Press}');
    expect(result.bibtex).toContain('address = {Geneva}');
    expect(result.bibtex).toContain('url = {https://www.who.int/report}');
    expect(result.bibtex).toContain('note = {Important report}');
    // Entry type should round-trip
    expect(result.bibtex).toContain('@techreport{');
  });

  it('preserves institution field through MD → DOCX → MD roundtrip', async () => {
    const md = `Report citation [@nchs2014].
`;
    const bib = `@techreport{nchs2014,
  institution = {National Center for Health Statistics},
  title = {{National Survey of Family Growth}},
  year = {2014},
}`;

    const docxResult = await convertMdToDocx(md, { bibtex: bib });
    const result = await convertDocx(docxResult.docx);

    // Institution field should survive the roundtrip
    expect(result.bibtex).toContain('institution = {National Center for Health Statistics}');
    expect(result.bibtex).toContain('@techreport{');
  });

  it('preserves editor and collection-title through round-trip', async () => {
    const md = `See [@smith2020chapter].
`;
    const bib = `@incollection{smith2020chapter,
  author = {Smith, John},
  title = {{A Great Chapter}},
  booktitle = {The Big Book},
  editor = {Editor, Jane and {Editorial Committee}},
  year = {2020},
  publisher = {Academic Press},
  series = {Research Series},
  pages = {100-120},
}`;

    const docxResult = await convertMdToDocx(md, { bibtex: bib });
    const result = await convertDocx(docxResult.docx);

    expect(result.bibtex).toContain('editor = {Editor, Jane and {Editorial Committee}}');
    expect(result.bibtex).toContain('booktitle = {The Big Book}');
    expect(result.bibtex).toContain('publisher = {Academic Press}');
    expect(result.bibtex).toContain('series = {Research Series}');
    expect(result.bibtex).toContain('@incollection{');
  });
});

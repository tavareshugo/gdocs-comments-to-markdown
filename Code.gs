function doGet() {
  return HtmlService.createHtmlOutputFromFile('index')
    .setTitle('Comments to Markdown');
}

function extractCommentsMarkdown(docUrl) {
  var fileId = extractDocId_(docUrl);
  if (!fileId) {
    throw new Error("That doesn't look like a Google Docs URL.");
  }

  var title = Drive.Files.get(fileId, {fields: 'name'}).name;
  var threads = orderThreadsByDocumentPosition_(fetchComments_(fileId), fileId)
    .filter(function (thread) {
      return thread.resolved !== true;
    });
  return threads.length
    ? buildMarkdown_(title, threads)
    : 'No open comments found.';
}

function extractDocId_(docUrl) {
  var match = String(docUrl || '').match(/\/d\/([a-zA-Z0-9_-]+)/);
  return match ? match[1] : '';
}

function debugExportHtml() {
  var DEBUG_DOC_URL = 'PASTE_A_GOOGLE_DOCS_URL_HERE';
  var fileId = extractDocId_(DEBUG_DOC_URL);
  if (!fileId) {
    throw new Error("Set DEBUG_DOC_URL to a valid Google Docs URL before running debugExportHtml().");
  }

  var html = fetchHtmlExport_(fileId);
  var parsed = parseCommentExportHtml_(html);
  var comments = fetchComments_(fileId);
  var ordered = orderThreadsByDocumentPosition_(comments, fileId, html, parsed);

  Logger.log('HTML length: ' + html.length);
  Logger.log('Body markers: ' + JSON.stringify(parsed.markers));
  Logger.log('Comment blocks: ' + JSON.stringify(parsed.blocks.map(function (block) {
    return {
      id: block.id,
      refId: block.refId,
      markerIndex: block.markerIndex === undefined ? null : block.markerIndex,
      text: truncate_(block.text, 80)
    };
  })));
  var entries = getApiEntries_(ordered);
  Logger.log(
    'Parsed %s body markers, %s comment blocks, %s matched API entries.',
    parsed.markers.length,
    parsed.blocks.length,
    entries.filter(function (entry) {
      return entry.markerIndex !== null;
    }).length
  );
  entries.forEach(function (entry) {
    Logger.log(
      '%s %s: %s (marker index: %s)',
      entry.type,
      entry.id,
      truncate_(normalizeText_(entry.content), 80),
      entry.markerIndex === null ? 'not matched' : entry.markerIndex
    );
  });
}

function fetchComments_(fileId) {
  var comments = [];
  var pageToken;
  var fields =
    'nextPageToken,comments(id,author(displayName),content,htmlContent,' +
    'createdTime,resolved,deleted,quotedFileContent(value),' +
    'replies(author(displayName),content,htmlContent,createdTime,deleted,action))';

  do {
    var options = {
      fields: fields,
      pageSize: 100,
      includeDeleted: false
    };
    if (pageToken) {
      options.pageToken = pageToken;
    }

    var response = Drive.Comments.list(fileId, options);
    (response.comments || []).forEach(function (comment) {
      if (comment.deleted === true) {
        return;
      }

      comment.replies = (comment.replies || []).filter(function (reply) {
        return reply.deleted !== true &&
          normalizeText_(reply.content || reply.htmlContent || '') !== '';
      });
      comments.push(comment);
    });
    pageToken = response.nextPageToken;
  } while (pageToken);

  comments.sort(sortByCreatedTime_);
  comments.forEach(function (comment) {
    comment.replies.sort(sortByCreatedTime_);
  });
  return comments;
}

function fetchHtmlExport_(fileId) {
  try {
    var blob = Drive.Files.export(fileId, 'text/html');
    return blob && typeof blob.getDataAsString === 'function'
      ? blob.getDataAsString()
      : String(blob || '');
  } catch (driveError) {
    try {
      var url = 'https://www.googleapis.com/drive/v3/files/' +
        encodeURIComponent(fileId) + '/export?mimeType=text%2Fhtml';
      var response = UrlFetchApp.fetch(url, {
        headers: {
          Authorization: 'Bearer ' + ScriptApp.getOAuthToken()
        },
        muteHttpExceptions: true
      });
      if (response.getResponseCode() >= 200 && response.getResponseCode() < 300) {
        return response.getContentText();
      }
    } catch (fetchError) {
      Logger.log('HTML export fallback failed: ' + fetchError);
    }
    Logger.log('HTML export failed: ' + driveError);
    return '';
  }
}

function parseCommentExportHtml_(html) {
  var bodyMatch = String(html || '').match(/<body\b[^>]*>([\s\S]*?)<\/body\s*>/i);
  var body = bodyMatch ? bodyMatch[1] : String(html || '');
  var markers = [];
  var markerByRefId = {};
  var anchorPattern = /<a\b[^>]*>[\s\S]*?<\/a\s*>/gi;
  var anchorMatch;

  while ((anchorMatch = anchorPattern.exec(body)) !== null) {
    var anchor = anchorMatch[0];
    var href = getHtmlAttribute_(anchor, 'href');
    var id = getHtmlAttribute_(anchor, 'id');
    if (/^#cmnt[\w-]+$/i.test(href) && /^cmnt_ref[\w-]+$/i.test(id)) {
      var marker = {
        id: href.slice(1),
        refId: id,
        index: markers.length
      };
      markers.push(marker);
      markerByRefId[id.toLowerCase()] = marker.index;
    }
  }

  var blocks = [];
  var paragraphPattern = /<p\b[^>]*>[\s\S]*?<\/p\s*>/gi;
  var paragraphMatch;
  while ((paragraphMatch = paragraphPattern.exec(body)) !== null) {
    var paragraph = paragraphMatch[0];
    var markerAnchorMatch = paragraph.match(
      /<a\b(?=[^>]*\bid\s*=\s*(['"])cmnt[\w-]+\1)(?=[^>]*\bhref\s*=\s*(['"])#cmnt_ref[\w-]+\2)[^>]*>[\s\S]*?<\/a\s*>/i
    );
    if (!markerAnchorMatch) {
      continue;
    }
    var markerAnchor = markerAnchorMatch[0];
    var blockId = getHtmlAttribute_(markerAnchor, 'id');
    var blockHref = getHtmlAttribute_(markerAnchor, 'href');
    var rawText = paragraph.replace(markerAnchor, '');
    blocks.push({
      id: blockId,
      refId: blockHref.slice(1),
      markerIndex: markerByRefId[blockHref.slice(1).toLowerCase()],
      text: normalizeText_(rawText)
    });
  }

  return {
    markers: markers,
    blocks: blocks
  };
}

function orderThreadsByDocumentPosition_(threads, fileId, html, parsed) {
  var orderedThreads = threads.slice().sort(sortByCreatedTime_);
  var exportHtml = html;
  var exportData = parsed;
  if (exportHtml === undefined) {
    exportHtml = fetchHtmlExport_(fileId);
  }
  if (exportData === undefined) {
    exportData = parseCommentExportHtml_(exportHtml);
  }
  if (!exportData.markers.length) {
    return orderedThreads;
  }

  matchApiEntriesToBlocks_(orderedThreads, exportData.blocks);
  orderedThreads.forEach(function (thread) {
    var positions = getApiEntries_([thread]).map(function (entry) {
      return entry.markerIndex;
    }).filter(function (index) {
      return index !== null;
    });
    thread.documentPosition = positions.length ? Math.min.apply(null, positions) : null;
  });
  return orderedThreads.sort(function (left, right) {
    var leftPosition = left.documentPosition;
    var rightPosition = right.documentPosition;
    if (leftPosition === null && rightPosition === null) {
      return sortByCreatedTime_(left, right);
    }
    if (leftPosition === null) {
      return 1;
    }
    if (rightPosition === null) {
      return -1;
    }
    return leftPosition - rightPosition;
  });
}

function matchApiEntriesToBlocks_(threads, blocks) {
  var entries = getApiEntries_(threads).sort(sortByCreatedTime_);
  var entriesByText = Object.create(null);
  var unmatchedEntries = [];
  entries.forEach(function (entry) {
    entry.markerIndex = null;
    var key = normalizeText_(entry.content);
    if (!key) {
      return;
    }
    if (!Object.prototype.hasOwnProperty.call(entriesByText, key)) {
      entriesByText[key] = [];
    }
    entriesByText[key].push(entry);
    unmatchedEntries.push(entry);
  });

  var unmatchedBlocks = [];
  blocks.forEach(function (block) {
    var entry = popFirstUnmatchedCandidate_(entriesByText, block.text);
    if (!entry) {
      var variants = getMatchTextVariants_(block.text);
      for (var i = 1; i < variants.length && !entry; i++) {
        entry = popFirstUnmatchedCandidate_(entriesByText, variants[i]);
      }
    }
    if (entry && entry.markerIndex === null &&
        block.markerIndex !== undefined && block.markerIndex !== null) {
      entry.markerIndex = block.markerIndex;
      entry.target.markerIndex = block.markerIndex;
      removeEntry_(unmatchedEntries, entry);
    } else {
      unmatchedBlocks.push(block);
    }
  });

  unmatchedBlocks.forEach(function (block) {
    if (block.markerIndex === undefined || block.markerIndex === null || !block.text) {
      return;
    }
    var entry = findLooseMatchEntry_(unmatchedEntries, block.text);
    if (entry) {
      entry.markerIndex = block.markerIndex;
      entry.target.markerIndex = block.markerIndex;
      removeEntry_(unmatchedEntries, entry);
    }
  });
}

function popFirstUnmatchedCandidate_(entriesByText, textKey) {
  var candidates = entriesByText[textKey] || [];
  while (candidates.length) {
    var entry = candidates.shift();
    if (entry.markerIndex === null) {
      return entry;
    }
  }
  return null;
}

function getApiEntries_(threads) {
  var entries = [];
  threads.forEach(function (thread) {
    entries.push({
      id: thread.id,
      type: 'comment',
      content: thread.content || '',
      createdTime: thread.createdTime || '',
      thread: thread,
      target: thread,
      markerIndex: thread.markerIndex === undefined ? null : thread.markerIndex
    });
    (thread.replies || []).forEach(function (reply, index) {
      entries.push({
        id: thread.id + '/reply-' + index,
        type: 'reply',
        content: reply.content || '',
        createdTime: reply.createdTime || '',
        thread: thread,
        reply: reply,
        target: reply,
        markerIndex: reply.markerIndex === undefined ? null : reply.markerIndex
      });
    });
  });
  return entries;
}

function getHtmlAttribute_(tag, name) {
  var pattern = new RegExp(
    '\\b' + name + '\\s*=\\s*([\'"])([\\s\\S]*?)\\1',
    'i'
  );
  var match = tag.match(pattern);
  return match ? decodeHtmlEntities_(match[2]) : '';
}

function normalizeText_(text) {
  return decodeHtmlEntities_(String(text || '')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]*>/g, ' '))
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function findLooseMatchEntry_(entries, blockText) {
  var variants = getMatchTextVariants_(blockText);
  var best = null;
  var blockLength = blockText.length;
  entries.forEach(function (entry) {
    var entryText = normalizeText_(entry.content);
    if (!entryText) {
      return;
    }
    if (variants.some(function (text) { return text === entryText; })) {
      if (!best || sortByCreatedTime_(entry, best.entry) < 0) {
        best = {entry: entry, score: 0};
      }
      return;
    }
    var contains = variants.some(function (text) {
      return text.indexOf(entryText) !== -1 || entryText.indexOf(text) !== -1;
    });
    if (!contains) {
      return;
    }
    var score = Math.abs(blockLength - entryText.length);
    if (!best ||
        score < best.score ||
        (score === best.score && sortByCreatedTime_(entry, best.entry) < 0)) {
      best = {entry: entry, score: score};
    }
  });
  return best ? best.entry : null;
}

function getMatchTextVariants_(text) {
  var normalized = normalizeText_(text);
  var variants = [normalized];
  var withoutAuthor = normalized.replace(/^[^:]{1,120}:\s+/, '');
  if (withoutAuthor && withoutAuthor !== normalized) {
    variants.push(withoutAuthor);
  }
  return variants;
}

function removeEntry_(entries, entryToRemove) {
  var index = entries.indexOf(entryToRemove);
  if (index !== -1) {
    entries.splice(index, 1);
  }
}

function truncate_(text, length) {
  text = String(text || '');
  return text.length > length ? text.slice(0, length - 3) + '...' : text;
}

function buildMarkdown_(title, threads) {
  var lines = ['# ' + title, '', 'Exported: ' + formatExportDate_(), ''];

  threads.forEach(function (thread, index) {
    var entries = [];
    var quote = thread.quotedFileContent && thread.quotedFileContent.value;
    if (quote) {
      entries.push(quoteToBlockquote_(quote));
    } else {
      entries.push('> [Comment on a non-text element, e.g. an image]');
    }

    entries.push(
      formatComment_(
        thread.author && thread.author.displayName,
        thread.htmlContent || thread.content || ''
      )
    );
    (thread.replies || []).forEach(function (reply) {
      entries.push(
        formatComment_(
          reply.author && reply.author.displayName,
          reply.htmlContent || reply.content || ''
        )
      );
    });

    lines.push('## ' + (index + 1), '', entries.join('\n\n'), '');
  });

  return lines.join('\n').replace(/\n+$/, '');
}

function formatComment_(author, html) {
  var name = author || 'Unknown author';
  return '**' + name + ':** ' + htmlToMarkdown_(html);
}

function htmlToMarkdown_(html) {
  var markdown = String(html || '')
    .replace(/<a\b[^>]*\bhref\s*=\s*(['"])(.*?)\1[^>]*>([\s\S]*?)<\/a>/gi,
      function (_, quote, url, text) {
        var linkText = htmlToText_(text);
        return '[' + linkText + '](' + decodeHtmlEntities_(url) + ')';
      })
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(?:p|div|li|blockquote|h[1-6])\s*>/gi, '\n')
    .replace(/<(?:p|div|li|blockquote|h[1-6])\b[^>]*>/gi, '');

  markdown = htmlToText_(markdown).replace(/\r\n?/g, '\n');
  return markdown.split('\n').join('  \n').replace(/[ \t]+  \n/g, '  \n').trim();
}

function htmlToText_(html) {
  return decodeHtmlEntities_(String(html || '').replace(/<[^>]*>/g, ''));
}

function decodeHtmlEntities_(text) {
  return String(text || '').replace(
    /&(amp|lt|gt|quot|#39|nbsp|#x27|#39);/gi,
    function (entity) {
      var values = {
        amp: '&',
        lt: '<',
        gt: '>',
        quot: '"',
        '#39': "'",
        nbsp: ' ',
        '#x27': "'"
      };
      return values[entity.slice(1, -1).toLowerCase()] || entity;
    }
  ).replace(/&#(\d+);/g, function (_, code) {
    return String.fromCharCode(Number(code));
  }).replace(/&#x([0-9a-f]+);/gi, function (_, code) {
    return String.fromCharCode(parseInt(code, 16));
  });
}

function quoteToBlockquote_(text) {
  return String(text).split(/\r\n?|\n/).map(function (line) {
    return '> ' + line;
  }).join('\n');
}

function sortByCreatedTime_(left, right) {
  var leftTime = Date.parse(left.createdTime || '');
  var rightTime = Date.parse(right.createdTime || '');
  if (!isNaN(leftTime) && !isNaN(rightTime)) {
    return leftTime - rightTime;
  }
  return String(left.createdTime || '').localeCompare(String(right.createdTime || ''));
}

function formatExportDate_() {
  return Utilities.formatDate(
    new Date(),
    Session.getScriptTimeZone(),
    'yyyy-MM-dd'
  );
}

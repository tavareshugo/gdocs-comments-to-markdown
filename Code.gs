function onOpen() {
  DocumentApp.getUi()
    .createMenu('Comments Export')
    .addItem('Extract comments to Markdown', 'showCommentsMarkdown')
    .addToUi();
}

function showCommentsMarkdown() {
  var ui = DocumentApp.getUi();

  try {
    var document = DocumentApp.getActiveDocument();
    var threads = fetchOpenComments_(document.getId());
    var markdown = threads.length
      ? buildMarkdown_(document.getName(), threads)
      : 'No open comments found.';
    var template = HtmlService.createTemplateFromFile('dialog');
    template.markdownJson = jsonForScript_(markdown);

    ui.showModalDialog(
      template.evaluate().setWidth(700).setHeight(550),
      'Comments as Markdown'
    );
  } catch (error) {
    var message = error && error.message ? error.message : String(error);
    if (/getActiveDocument/i.test(message)) {
      message =
        'This script must be bound to a Google Doc. Open the target Doc, then use ' +
        'Extensions > Apps Script and run the menu item from that document.';
    } else if (/advanced service|drive\.comments|service.*enabled|not found/i.test(message)) {
      message += '\n\nEnable the Drive API advanced service in Extensions > Apps Script > Services.';
    }
    ui.alert(
      'Unable to export comments',
      message,
      ui.ButtonSet.OK
    );
  }
}

function fetchOpenComments_(fileId) {
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
      if (comment.resolved === true || comment.deleted === true) {
        return;
      }

      comment.replies = (comment.replies || []).filter(function (reply) {
        return reply.deleted !== true &&
          (reply.content || reply.htmlContent || '').trim() !== '';
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

function buildMarkdown_(title, threads) {
  var lines = ['# ' + title, '', 'Exported: ' + formatExportDate_(), ''];

  threads.forEach(function (thread, index) {
    var entries = [];
    var quote = thread.quotedFileContent && thread.quotedFileContent.value;
    if (quote) {
      entries.push(quoteToBlockquote_(quote));
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
  return String(left.createdTime || '').localeCompare(String(right.createdTime || ''));
}

function formatExportDate_() {
  return Utilities.formatDate(
    new Date(),
    Session.getScriptTimeZone(),
    'yyyy-MM-dd'
  );
}

function jsonForScript_(value) {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

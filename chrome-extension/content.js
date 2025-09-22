/**
 * Trello Comment Scheduler - Chrome Extension
 * Author: Dennis Klappe
 * Website: https://klappe.dev
 * GitHub: https://github.com/dennisklappe/
 */

(() => {
  'use strict';

  const WORKER_URL = 'https://your-worker-name.your-subdomain.workers.dev' // CHANGE THIS;
  let processedElements = new WeakSet();
  let lastUpdateTime = 0;

  // Function to get relative time display
  function getRelativeTime(date) {
    const now = new Date();
    const diffMs = date - now;
    const diffMinutes = Math.floor(diffMs / (1000 * 60));
    const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
    const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

    if (diffMs < 0) return 'past due';
    if (diffDays > 0) return `in ${diffDays} day${diffDays > 1 ? 's' : ''}`;
    if (diffHours > 0) return `in ${diffHours} hour${diffHours > 1 ? 's' : ''}`;
    if (diffMinutes > 0) return `in ${diffMinutes} minute${diffMinutes > 1 ? 's' : ''}`;
    return 'soon';
  }

  // Local storage functions for scheduled comments
  function saveScheduledComment(cardId, comment, scheduledTime, kvKey = null) {
    const key = `scheduled_comments_${cardId}`;
    const existing = JSON.parse(localStorage.getItem(key) || '[]');
    const newItem = { comment, scheduledTime, id: Date.now(), kvKey };
    existing.push(newItem);
    localStorage.setItem(key, JSON.stringify(existing));
  }

  function getScheduledComments(cardId) {
    const key = `scheduled_comments_${cardId}`;
    const comments = JSON.parse(localStorage.getItem(key) || '[]');
    // Filter out past comments
    const now = new Date();
    const future = comments.filter(c => new Date(c.scheduledTime) > now);
    // Update storage if we filtered any out
    if (future.length !== comments.length) {
      localStorage.setItem(key, JSON.stringify(future));
    }
    // Sort by scheduled time
    return future.sort((a, b) => new Date(a.scheduledTime) - new Date(b.scheduledTime));
  }

  // Get Trello token - first try localStorage (authorized token), then cookies
  function getTrelloToken() {
    // Check if we have an authorized token in localStorage
    const authToken = localStorage.getItem('trello_auth_token');
    if (authToken) {
      return authToken;
    }

    // Fallback to cookie token (won't work for API calls)
    const match = document.cookie.match(/token=([^;]+)/);
    if (match) {
      // Don't return cookie token as it doesn't work
      // return match[1];
    }

    return null;
  }

  // Get card ID from URL or card element
  function getCardId(element) {
    // Try URL first
    const urlMatch = window.location.pathname.match(/\/c\/([a-zA-Z0-9]+)/);
    if (urlMatch) return urlMatch[1];

    // Try finding from card element
    const card = element.closest('.js-card-detail');
    if (card) {
      const cardLink = card.querySelector('a.js-card-detail-title-assist');
      if (cardLink) {
        const href = cardLink.getAttribute('href');
        const match = href && href.match(/\/c\/([a-zA-Z0-9]+)/);
        if (match) return match[1];
      }
    }
    return null;
  }

  // Create schedule button for comments
  function createScheduleButton() {
    const button = document.createElement('button');
    button.className = 'schedule-comment-btn';
    button.textContent = 'Scheduled Save';
    button.title = 'Schedule this comment to be posted later';
    return button;
  }

  // Create clock button for card completion
  function createClockButton() {
    const button = document.createElement('button');
    button.className = 'schedule-complete-btn';
    button.innerHTML = '🕐';
    button.title = 'Schedule completion status change';
    return button;
  }

  // Show scheduling dialog
  function showScheduleDialog(cardId, comment = '', isCompletion = false, currentComplete = false) {
    const existingDialog = document.querySelector('.schedule-dialog');
    if (existingDialog) {
      existingDialog.remove();
    }

    const dialog = document.createElement('div');
    dialog.className = 'schedule-dialog';

    // Get current time and create default options
    const now = new Date();
    const currentHour = now.getHours();
    const currentMinute = now.getMinutes();

    // Create quick select options
    const quickOptions = [
      { label: 'In 5 minutes', minutes: 5 },
      { label: 'In 15 minutes', minutes: 15 },
      { label: 'In 1 hour', minutes: 60 },
      { label: 'Today at 1 PM', today: true, hour: 13 },
      { label: 'Tomorrow at 9 AM', tomorrow: true, hour: 9 },
      { label: 'Tomorrow at 2 PM', tomorrow: true, hour: 14 },
    ];

    // Format datetime-local value (adjusted for timezone)
    function formatDateTimeLocal(date) {
      const year = date.getFullYear();
      const month = String(date.getMonth() + 1).padStart(2, '0');
      const day = String(date.getDate()).padStart(2, '0');
      const hours = String(date.getHours()).padStart(2, '0');
      const minutes = String(date.getMinutes()).padStart(2, '0');
      return `${year}-${month}-${day}T${hours}:${minutes}`;
    }

    // Default to 1 minute from now
    const defaultDate = new Date(now.getTime() + 1 * 60000);
    const defaultDateTime = formatDateTimeLocal(defaultDate);
    const minDateTime = formatDateTimeLocal(now);

    // Determine dialog title and content based on context
    let dialogTitle = 'Schedule Comment';
    let fieldContent = '';

    if (isCompletion) {
      dialogTitle = 'Schedule Card Completion';
      fieldContent = `
        <div class="schedule-field">
          <div class="schedule-comment-preview">Card will be marked as <strong>complete</strong></div>
        </div>
      `;
    } else {
      fieldContent = `
        <div class="schedule-field">
          <label>Comment Preview:</label>
          <div class="schedule-comment-preview">${comment.substring(0, 100)}${comment.length > 100 ? '...' : ''}</div>
        </div>
      `;
    }

    dialog.innerHTML = `
      <div class="schedule-dialog-content">
        <div class="schedule-header">
          <h3>${dialogTitle}</h3>
          <button class="schedule-close-x" title="Close">×</button>
        </div>
        ${fieldContent}

        <div class="schedule-field">
          <label>⏰ Quick Select:</label>
          <div class="quick-time-buttons">
            ${quickOptions.map(opt => `
              <button class="quick-time-btn" data-minutes="${opt.minutes || 0}"
                      data-tomorrow="${opt.tomorrow || false}"
                      data-today="${opt.today || false}"
                      data-hour="${opt.hour || 0}">
                ${opt.label}
              </button>
            `).join('')}
          </div>
        </div>

        <div class="schedule-field">
          <label>🕐 Custom Date & Time:</label>
          <input type="datetime-local" class="schedule-time" value="${defaultDateTime}" min="${minDateTime}">
          <div class="time-note">Your local time: ${now.toLocaleString()}</div>
        </div>

        <div class="schedule-buttons">
          <button class="schedule-confirm">✅ Confirm Schedule</button>
          <button class="schedule-cancel">❌ Cancel</button>
        </div>
        <div class="schedule-status"></div>
      </div>
    `;

    document.body.appendChild(dialog);

    // Create a transparent overlay behind the dialog to capture clicks
    const overlay = document.createElement('div');
    overlay.style.cssText = `
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      z-index: 9999;
    `;
    dialog.insertBefore(overlay, dialog.firstChild);

    // Prevent closing when clicking the overlay
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) {
        dialog.remove();
      }
    });

    // Prevent dialog content clicks from bubbling
    const dialogContent = dialog.querySelector('.schedule-dialog-content');
    dialogContent.style.position = 'relative';
    dialogContent.style.zIndex = '10001';

    // Function to check if datetime matches a quick option
    function matchesQuickOption(dateValue) {
      const date = new Date(dateValue);
      const now = new Date();

      for (const opt of quickOptions) {
        let targetDate = new Date();

        if (opt.tomorrow) {
          targetDate.setDate(targetDate.getDate() + 1);
          targetDate.setHours(opt.hour, 0, 0, 0);
        } else if (opt.today) {
          targetDate.setHours(opt.hour, 0, 0, 0);
        } else {
          targetDate = new Date(targetDate.getTime() + opt.minutes * 60000);
        }

        // Check if dates match within 1 minute tolerance
        if (Math.abs(date.getTime() - targetDate.getTime()) < 60000) {
          return opt.label;
        }
      }
      return null;
    }

    // Handle quick time buttons
    dialog.querySelectorAll('.quick-time-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const minutes = parseInt(btn.dataset.minutes);
        const tomorrow = btn.dataset.tomorrow === 'true';
        const today = btn.dataset.today === 'true';
        const hour = parseInt(btn.dataset.hour);

        let targetDate = new Date();

        if (tomorrow) {
          targetDate.setDate(targetDate.getDate() + 1);
          targetDate.setHours(hour, 0, 0, 0);
        } else if (today) {
          targetDate.setHours(hour, 0, 0, 0);
          // If the time has already passed today, don't allow selection
          if (targetDate <= new Date()) {
            return;
          }
        } else {
          targetDate = new Date(targetDate.getTime() + minutes * 60000);
        }

        dialog.querySelector('.schedule-time').value = formatDateTimeLocal(targetDate);

        // Update button selection
        dialog.querySelectorAll('.quick-time-btn').forEach(b => {
          b.classList.remove('selected');
        });
        btn.classList.add('selected');
      });
    });

    // Monitor custom time input changes
    const timeInput = dialog.querySelector('.schedule-time');
    timeInput.addEventListener('input', (e) => {
      const matchingLabel = matchesQuickOption(e.target.value);
      dialog.querySelectorAll('.quick-time-btn').forEach(btn => {
        if (matchingLabel && btn.textContent === matchingLabel) {
          btn.classList.add('selected');
        } else {
          btn.classList.remove('selected');
        }
      });
    });

    // Check initial value
    const initialMatch = matchesQuickOption(timeInput.value);
    if (initialMatch) {
      dialog.querySelectorAll('.quick-time-btn').forEach(btn => {
        if (btn.textContent === initialMatch) {
          btn.classList.add('selected');
        }
      });
    }

    // Handle close button
    dialog.querySelector('.schedule-close-x').addEventListener('click', (e) => {
      dialog.remove();
    });

    // Handle confirm
    const confirmBtn = dialog.querySelector('.schedule-confirm');
    confirmBtn.addEventListener('click', async (e) => {
      // Prevent double-clicks
      if (confirmBtn.disabled) return;
      confirmBtn.disabled = true;
      const originalText = confirmBtn.textContent;
      confirmBtn.textContent = 'Scheduling...';

      const scheduledTime = dialog.querySelector('.schedule-time').value;
      const status = dialog.querySelector('.schedule-status');

      if (!scheduledTime) {
        status.textContent = 'Please select a time';
        status.style.color = 'red';
        confirmBtn.disabled = false;
        confirmBtn.textContent = originalText;
        return;
      }

      // Force using the proper token
      const token = getTrelloToken(); if (!token) { alert('Please set your Trello token first - see README'); return; }
      

      

      status.textContent = 'Scheduling...';
      status.style.color = 'blue';

      try {
        const payload = {
          cardId,
          scheduledTime: new Date(scheduledTime).toISOString(),
          trelloToken: token
        };

        if (isCompletion) {
          payload.markComplete = true; // Always mark as complete
        } else {
          payload.comment = comment;
        }

        const response = await fetch(`${WORKER_URL}/schedule`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(payload)
        });

        const result = await response.json();

        if (response.ok && result.success) {
          status.innerHTML = `✅ <strong>Successfully scheduled!</strong><br>Will post at: ${new Date(scheduledTime).toLocaleString()}`;
          status.className = 'schedule-status success';

          // Save to local storage for display
          if (!isCompletion && comment) {
            saveScheduledComment(cardId, comment, scheduledTime, result.key);

            // Clear the comment box
            const editors = document.querySelectorAll('.ProseMirror');
            editors.forEach(editor => {
              if (editor.textContent === comment) {
                editor.innerHTML = '<p data-prosemirror-content-type="node" data-prosemirror-node-name="paragraph" data-prosemirror-node-block="true"></p>';
              }
            });

            // Update all displays
            updateScheduledItemsDisplay();
          } else if (isCompletion) {
            // Log scheduled card completion
            addScheduledActivityLog(cardId, 'Card completion status', true, new Date(scheduledTime));
          }

          // Update scheduled displays
          updateScheduledItemsDisplay();

          setTimeout(() => {
            dialog.remove();
          }, 2500);
        } else {
          throw new Error(result.error || 'Failed to schedule');
        }
      } catch (error) {
        status.innerHTML = `❌ <strong>Error:</strong> ${error.message}`;
        status.className = 'schedule-status error';
        confirmBtn.disabled = false;
        confirmBtn.textContent = originalText;
      }
    });

    // Handle cancel
    dialog.querySelector('.schedule-cancel').addEventListener('click', (e) => {
      dialog.remove();
    });
  }

  // Add schedule button to comment composers
  function processCommentComposers() {
    // Try multiple selectors for different Trello versions
    const saveButtons = document.querySelectorAll('[data-testid="card-back-comment-save-button"], .js-add-comment');

    saveButtons.forEach(saveBtn => {
      // Check if we already processed this button's container
      const container = saveBtn.closest('.HPuvLwA7Bi5kXK') || saveBtn.parentElement;
      if (!container || processedElements.has(container)) return;

      // Get the comment text from the editor
      const getCommentText = () => {
        // Try to find the ProseMirror editor
        const editor = document.querySelector('.ProseMirror');
        if (editor) {
          // Check if it's just the placeholder or empty
          const text = editor.textContent.trim();
          // Skip if it's the placeholder text or empty
          if (!text || text === 'Write a comment…' || text === '') {
            return '';
          }
          // Also check if there's only a trailing break (empty editor)
          const hasOnlyBreak = editor.querySelector('br.ProseMirror-trailingBreak') &&
                               editor.querySelectorAll('*:not(br):not(p)').length === 0;
          if (hasOnlyBreak) {
            return '';
          }
          return text;
        }
        // Fallback to old textarea
        const textarea = document.querySelector('.comment-box-input');
        if (textarea) {
          return textarea.value.trim();
        }
        return '';
      };

      // Helper function to get relative time
      function getRelativeTime(date) {
        const now = new Date();
        const diff = date - now;
        const minutes = Math.floor(diff / 60000);
        const hours = Math.floor(minutes / 60);
        const days = Math.floor(hours / 24);

        if (days > 0) return `in ${days} day${days > 1 ? 's' : ''}`;
        if (hours > 0) return `in ${hours} hour${hours > 1 ? 's' : ''}`;
        if (minutes > 0) return `in ${minutes} minute${minutes > 1 ? 's' : ''}`;
        return 'soon';
      }


      const scheduleBtn = createScheduleButton();
      scheduleBtn.style.marginLeft = '8px';

      // Function to update button states based on text content
      const updateButtonStates = () => {
        const commentText = getCommentText();
        const hasText = !!commentText;

        // Update scheduled save button
        scheduleBtn.disabled = !hasText;
        scheduleBtn.style.opacity = hasText ? '' : '0.5';
        scheduleBtn.style.cursor = hasText ? '' : 'not-allowed';

        // Update tomorrow 9am button (but don't disable if already processing)
        if (quickBtn && !quickBtn.textContent.includes('Scheduling') && !quickBtn.textContent.includes('Scheduled')) {
          quickBtn.disabled = !hasText;
          quickBtn.style.opacity = hasText ? '' : '0.5';
          quickBtn.style.cursor = hasText ? '' : 'not-allowed';
        }
      };

      scheduleBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();

        const commentText = getCommentText();
        if (!commentText) {
          return;
        }

        const cardId = getCardId(saveBtn);
        if (!cardId) {
          alert('Could not determine card ID');
          return;
        }

        showScheduleDialog(cardId, commentText);

        // Clear the comment box after opening dialog
        const editors = document.querySelectorAll('.ProseMirror');
        editors.forEach(editor => {
          if (editor.textContent === commentText) {
            editor.innerHTML = '<p data-prosemirror-content-type="node" data-prosemirror-node-name="paragraph" data-prosemirror-node-block="true"></p>';
          }
        });
      });

      // Create quick "Tomorrow 9am" button
      const quickBtn = document.createElement('button');
      quickBtn.className = 'schedule-comment-btn';
      quickBtn.textContent = 'Tomorrow 9am';
      quickBtn.style.marginLeft = '8px';

      quickBtn.addEventListener('click', async (e) => {
        e.preventDefault();
        e.stopPropagation();

        const commentText = getCommentText();
        if (!commentText) {
          return;
        }

        const cardId = getCardId(saveBtn);
        if (!cardId) {
          alert('Could not determine card ID');
          return;
        }

        // Schedule for tomorrow at 9am
        const tomorrow = new Date();
        tomorrow.setDate(tomorrow.getDate() + 1);
        tomorrow.setHours(9, 0, 0, 0);

        // Force using the proper token
        const token = getTrelloToken(); if (!token) { alert('Please set your Trello token first - see README'); return; }

        // Quick schedule without dialog
        quickBtn.textContent = 'Scheduling...';
        quickBtn.disabled = true;

        try {
          const payload = {
            cardId,
            comment: commentText,
            scheduledTime: tomorrow.toISOString(),
            trelloToken: token
          };

          const response = await fetch(`${WORKER_URL}/schedule`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
            },
            body: JSON.stringify(payload)
          });

          const result = await response.json();

          if (response.ok && result.success) {
            quickBtn.textContent = '✓ Scheduled!';
            quickBtn.style.background = '#4CAF50';
            quickBtn.style.color = 'white';

            // Save to local storage for display
            saveScheduledComment(cardId, commentText, tomorrow.toISOString(), result.key);

            // Clear the comment
            const editors = document.querySelectorAll('.ProseMirror');
            editors.forEach(editor => {
              if (editor.textContent === commentText) {
                editor.innerHTML = '<p data-prosemirror-content-type="node" data-prosemirror-node-name="paragraph" data-prosemirror-node-block="true"></p>';
              }
            });

            // Update all displays
            updateScheduledItemsDisplay();

            // Update button states after clearing
            setTimeout(updateButtonStates, 100);

            setTimeout(() => {
              quickBtn.textContent = 'Tomorrow 9am';
              quickBtn.style.background = '';
              quickBtn.style.color = '';
              quickBtn.disabled = false;
              // Re-check button state after reset
              updateButtonStates();
            }, 2000);
          } else {
            throw new Error(result.error || 'Failed to schedule');
          }
        } catch (error) {
          quickBtn.textContent = 'Error!';
          quickBtn.style.background = '#f44336';
          quickBtn.style.color = 'white';
          setTimeout(() => {
            quickBtn.textContent = 'Tomorrow 9am';
            quickBtn.style.background = '';
            quickBtn.style.color = '';
            quickBtn.disabled = false;
            // Re-check button state after reset
            updateButtonStates();
          }, 2000);
        }
      });

      // Insert buttons after the save button (removed view button)
      saveBtn.parentNode.insertBefore(scheduleBtn, saveBtn.nextSibling);
      saveBtn.parentNode.insertBefore(quickBtn, scheduleBtn.nextSibling);
      processedElements.add(container);

      // Set initial button states
      updateButtonStates();

      // Monitor for changes in the comment editor - try multiple times as editor loads async
      const setupEditorMonitoring = () => {
        const editor = document.querySelector('.ProseMirror');
        if (editor) {
          // Use MutationObserver for more reliable detection
          const observer = new MutationObserver(() => {
            updateButtonStates();
          });

          observer.observe(editor, {
            childList: true,
            subtree: true,
            characterData: true
          });

          // Also listen to input events
          editor.addEventListener('input', updateButtonStates);
          editor.addEventListener('keyup', updateButtonStates);
          editor.addEventListener('paste', () => setTimeout(updateButtonStates, 100));

          // Check state immediately
          updateButtonStates();
        }
      };

      // Try immediately and after short delays
      setupEditorMonitoring();
      setTimeout(setupEditorMonitoring, 100);
      setTimeout(setupEditorMonitoring, 500);
      setTimeout(setupEditorMonitoring, 1000);

    });
  }

  // Add buttons to sidebar for scheduling completion
  function processMarkCompleteButton() {
    // Find the sidebar buttons container (with Add, Dates, Checklist, etc.)
    const sidebarButtons = document.querySelector('.kQ4ufmmhr8aNSw.aozh3NIpS2lX05');
    if (!sidebarButtons || processedElements.has(sidebarButtons)) return;

    // Get the card ID
    const cardId = window.location.pathname.match(/\/c\/([a-zA-Z0-9]+)/)?.[1];
    if (!cardId) return;

    // Check if card is currently complete
    const completeBtn = document.querySelector('[data-testid="card-done-state-completion-button"]');
    const isComplete = completeBtn?.querySelector('[aria-label*="incomplete"]') !== null;

    // Create "Schedule Complete" button styled like the other sidebar buttons
    const scheduleCompleteBtn = document.createElement('button');
    scheduleCompleteBtn.className = 'Qa0qCr_1_yQKR9 ybVBgfOiuWZJtD mUpWqmjL4CZBvn _St8_YSRMkLv07';
    scheduleCompleteBtn.type = 'button';
    scheduleCompleteBtn.innerHTML = `
      <span class="nch-icon hChYpzFshATQo8 GzZMAuibTh5l1i HRDK8sNF4Ja3BM">
        <svg width="16" height="16" role="presentation" focusable="false" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
          <path fill-rule="evenodd" clip-rule="evenodd" d="M12 4C10.8954 4 10 4.89543 10 6C10 7.10457 10.8954 8 12 8C13.1046 8 14 7.10457 14 6C14 4.89543 13.1046 4 12 4ZM12 10C10.8954 10 10 10.8954 10 12C10 13.1046 10.8954 14 12 14C13.1046 14 14 13.1046 14 12C14 10.8954 13.1046 10 12 10ZM10 18C10 16.8954 10.8954 16 12 16C13.1046 16 14 16.8954 14 18C14 19.1046 13.1046 20 12 20C10.8954 20 10 19.1046 10 18Z" fill="currentColor"></path>
        </svg>
      </span>
      ${isComplete ? 'Sched. Incomplete' : 'Sched. Complete'}
    `;
    scheduleCompleteBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      showScheduleDialog(cardId, '', true, isComplete);
    });

    // Create "Tomorrow 9am" button for completion
    const tomorrowCompleteBtn = document.createElement('button');
    tomorrowCompleteBtn.className = 'Qa0qCr_1_yQKR9 ybVBgfOiuWZJtD mUpWqmjL4CZBvn _St8_YSRMkLv07';
    tomorrowCompleteBtn.type = 'button';
    tomorrowCompleteBtn.innerHTML = `
      <span class="nch-icon hChYpzFshATQo8 GzZMAuibTh5l1i HRDK8sNF4Ja3BM">
        <svg width="16" height="16" role="presentation" focusable="false" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
          <path fill-rule="evenodd" clip-rule="evenodd" d="M12 4C16.4183 4 20 7.58172 20 12C20 16.4183 16.4183 20 12 20C7.58172 20 4 16.4183 4 12C4 7.58172 7.58172 4 12 4ZM12 6C8.68629 6 6 8.68629 6 12C6 15.3137 8.68629 18 12 18C15.3137 18 18 15.3137 18 12C18 8.68629 15.3137 6 12 6ZM12 8C12.5523 8 13 8.44772 13 9V11.5858L14.7071 13.2929C15.0976 13.6834 15.0976 14.3166 14.7071 14.7071C14.3166 15.0976 13.6834 15.0976 13.2929 14.7071L11.2929 12.7071C11.1054 12.5196 11 12.2652 11 12V9C11 8.44772 11.4477 8 12 8Z" fill="currentColor"></path>
        </svg>
      </span>
      Tomorrow 9am
    `;
    tomorrowCompleteBtn.addEventListener('click', async (e) => {
      e.preventDefault();
      e.stopPropagation();

      // Schedule for tomorrow at 9am
      const tomorrow = new Date();
      tomorrow.setDate(tomorrow.getDate() + 1);
      tomorrow.setHours(9, 0, 0, 0);

      const token = getTrelloToken(); if (!token) { alert('Please set your Trello token first - see README'); return; }

      const originalHTML = tomorrowCompleteBtn.innerHTML;
      tomorrowCompleteBtn.innerHTML = `
        <span class="nch-icon hChYpzFshATQo8 GzZMAuibTh5l1i HRDK8sNF4Ja3BM">
          <svg width="16" height="16" role="presentation" focusable="false" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
            <path fill-rule="evenodd" clip-rule="evenodd" d="M12 4C16.4183 4 20 7.58172 20 12C20 16.4183 16.4183 20 12 20C7.58172 20 4 16.4183 4 12C4 7.58172 7.58172 4 12 4ZM12 6C8.68629 6 6 8.68629 6 12C6 15.3137 8.68629 18 12 18C15.3137 18 18 15.3137 18 12C18 8.68629 15.3137 6 12 6ZM12 8C12.5523 8 13 8.44772 13 9V11.5858L14.7071 13.2929C15.0976 13.6834 15.0976 14.3166 14.7071 14.7071C14.3166 15.0976 13.6834 15.0976 13.2929 14.7071L11.2929 12.7071C11.1054 12.5196 11 12.2652 11 12V9C11 8.44772 11.4477 8 12 8Z" fill="currentColor"></path>
          </svg>
        </span>
        Scheduling...
      `;
      tomorrowCompleteBtn.disabled = true;

      try {
        const payload = {
          cardId,
          markComplete: !isComplete, // Toggle the state
          scheduledTime: tomorrow.toISOString(),
          trelloToken: token
        };

        const response = await fetch(`${WORKER_URL}/schedule`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(payload)
        });

        const result = await response.json();

        if (response.ok && result.success) {
          tomorrowCompleteBtn.innerHTML = `
            <span class="nch-icon hChYpzFshATQo8 GzZMAuibTh5l1i HRDK8sNF4Ja3BM">
              <svg width="16" height="16" role="presentation" focusable="false" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
                <path fill-rule="evenodd" clip-rule="evenodd" d="M12 2C6.47715 2 2 6.47715 2 12C2 17.5228 6.47715 22 12 22C17.5228 22 22 17.5228 22 12C22 6.47715 17.5228 2 12 2ZM16.7071 9.29289C17.0976 8.90237 17.0976 8.26903 16.7071 7.87851C16.3166 7.48799 15.6834 7.48799 15.2929 7.87851L10 13.1714L8.70711 11.8785C8.31658 11.488 7.68342 11.488 7.29289 11.8785C6.90237 12.269 6.90237 12.9024 7.29289 13.2929L9.29289 15.2929C9.68342 15.6834 10.3166 15.6834 10.7071 15.2929L16.7071 9.29289Z" fill="currentColor"></path>
              </svg>
            </span>
            Scheduled!
          `;

          // Log to activity
          addScheduledActivityLog(cardId, 'Card completion status', !isComplete, tomorrow, result.key);

          setTimeout(() => {
            tomorrowCompleteBtn.innerHTML = originalHTML;
            tomorrowCompleteBtn.disabled = false;
          }, 2000);
        } else {
          throw new Error(result.error || 'Failed to schedule');
        }
      } catch (error) {
        tomorrowCompleteBtn.innerHTML = `
          <span class="nch-icon hChYpzFshATQo8 GzZMAuibTh5l1i HRDK8sNF4Ja3BM">
            <svg width="16" height="16" role="presentation" focusable="false" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
              <path fill-rule="evenodd" clip-rule="evenodd" d="M12 2C6.47715 2 2 6.47715 2 12C2 17.5228 6.47715 22 12 22C17.5228 22 22 17.5228 22 12C22 6.47715 17.5228 2 12 2ZM9.29289 8.29289C8.90237 8.68342 8.90237 9.31658 9.29289 9.70711L10.5858 11L9.29289 12.2929C8.90237 12.6834 8.90237 13.3166 9.29289 13.7071C9.68342 14.0976 10.3166 14.0976 10.7071 13.7071L12 12.4142L13.2929 13.7071C13.6834 14.0976 14.3166 14.0976 14.7071 13.7071C15.0976 13.3166 15.0976 12.6834 14.7071 12.2929L13.4142 11L14.7071 9.70711C15.0976 9.31658 15.0976 8.68342 14.7071 8.29289C14.3166 7.90237 13.6834 7.90237 13.2929 8.29289L12 9.58579L10.7071 8.29289C10.3166 7.90237 9.68342 7.90237 9.29289 8.29289Z" fill="currentColor"></path>
            </svg>
          </span>
          Error!
        `;
        setTimeout(() => {
          tomorrowCompleteBtn.innerHTML = originalHTML;
          tomorrowCompleteBtn.disabled = false;
        }, 2000);
      }
    });

    // Wrap buttons in presentational divs like the other buttons
    const scheduleDiv = document.createElement('div');
    scheduleDiv.setAttribute('role', 'presentation');
    scheduleDiv.appendChild(scheduleCompleteBtn);

    const tomorrowDiv = document.createElement('div');
    tomorrowDiv.setAttribute('role', 'presentation');
    tomorrowDiv.appendChild(tomorrowCompleteBtn);

    // Insert after the attachment button
    sidebarButtons.appendChild(scheduleDiv);
    sidebarButtons.appendChild(tomorrowDiv);

    processedElements.add(sidebarButtons);
  }

  // Add clock button to due date complete checkboxes
  function processDueDateCheckboxes() {
    const checkboxes = document.querySelectorAll('.js-due-date-badge, .js-card-detail-due-date-badge');

    checkboxes.forEach(checkbox => {
      if (processedElements.has(checkbox)) return;

      const container = checkbox.closest('.js-due-date-badge-container, .js-card-detail-due-date-container');
      if (!container) return;

      const clockBtn = createClockButton();
      const isComplete = checkbox.classList.contains('is-due-complete');

      clockBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();

        const cardId = getCardId(checkbox);
        if (!cardId) {
          alert('Could not determine card ID');
          return;
        }

        showScheduleDialog(cardId, '', true, isComplete);
      });

      container.appendChild(clockBtn);
      processedElements.add(checkbox);
    });
  }

  // Function to update all scheduled displays

  // Add scheduled activity log to show in comments
  function addScheduledActivityLog(cardId, itemDescription, markComplete, scheduledTime, kvKey = null) {
    const scheduledItems = JSON.parse(localStorage.getItem('scheduledCompletions') || '[]');

    const newItem = {
      cardId,
      itemDescription,
      markComplete,
      scheduledTime: scheduledTime.toISOString(),
      timestamp: new Date().toISOString(),
      kvKey
    };

    scheduledItems.push(newItem);
    localStorage.setItem('scheduledCompletions', JSON.stringify(scheduledItems));

    // Update any displayed scheduled items
    updateScheduledItemsDisplay();
  }

  // Function to display all scheduled items (comments and completions)
  function updateScheduledItemsDisplay() {
    // Throttle to reduce console spam - only run once per second max
    const now = Date.now();
    if (now - lastUpdateTime < 1000) return;
    lastUpdateTime = now;

    // Check if we're on a card page first to avoid unnecessary processing
    const cardId = window.location.pathname.match(/\/c\/([a-zA-Z0-9]+)/)?.[1];
    if (!cardId) return; // Not on a card page, skip silently

    // Find the comment thread container
    const selectors = [
      '.VxKRIoztMcODIj',
      'ul.card-back-redesign',
      '[data-testid="card-back-activity-list"]',
      '.js-list-actions',
      '.phenom-list',
      '.js-card-detail-activities-list',
      '.mod-card-back-activity ul',
      '.window-module .phenom'
    ];

    let commentThread = null;
    for (const selector of selectors) {
      commentThread = document.querySelector(selector);
      if (commentThread) {
        break; // Found it, no need to log
      }
    }

    if (!commentThread) {
      // Try alternative method silently
      const actionItem = document.querySelector('li[data-testid="card-back-action"], .phenom');
      if (actionItem) {
        commentThread = actionItem.closest('ul');
      }
    }

    if (!commentThread) {
      // Card page but no activity thread found - might still be loading
      return;
    }

    // Remove existing scheduled displays
    document.querySelectorAll('.scheduled-comment-item, .scheduled-completion-item').forEach(el => el.remove());

    // Display scheduled comments
    const scheduledComments = getScheduledComments(cardId);
    scheduledComments.forEach(schedule => {
      const schedTime = new Date(schedule.scheduledTime);
      const isPast = schedTime <= new Date();

      if (!isPast) {
        const relativeTime = getRelativeTime(schedTime);
        const commentColor = '#667eea'; // Purple color for comments

        const li = document.createElement('li');
        li.className = 'tHtuAoy3OW7uUR scheduled-comment-item';
        li.setAttribute('data-testid', 'card-back-action');

        li.innerHTML = `
          <div>
            <button class="w7KETlmrCN8Ekc PkNmqmQLu48HSf ybVBgfOiuWZJtD _St8_YSRMkLv07" type="button" title="Scheduled Comment" tabindex="0" aria-expanded="false">
              <span class="scheduled-avatar" style="display: inline-flex; align-items: center; justify-content: center; background: ${commentColor}; color: white; height: 32px; width: 32px; border-radius: 50%; font-size: 16px;">
                💬
              </span>
            </button>
          </div>
          <div class="xFvhqhjs5Kc6GV" data-testid="card-back-action-container">
            <div>
              <span class="DeB_YZayTLAXDU">
                <span class="Ai3iz3ksdQJNLc">
                  <span class="Gn87mV4xr5HQJh" style="color: ${commentColor}; font-style: italic;">Scheduled Comment</span>
                </span>
              </span>
              <span class="iqpuBPSRgp54GF cMjKAsoVQYsKab" style="color: #888;">
                <span title="${schedTime.toLocaleString()}">${relativeTime}</span>
              </span>
            </div>
            <div class="l4lQedPGf8KN1w" role="button">
              <div class="_4MrlvXRZe6dnu" data-testid="comment-container">
                <div class="R1RfC8jJFTMJlv Xfg5GTUiZ1tTRp" style="opacity: 0.85;">
                  <div class="hPERvAPxokg05x Ijf59q3IL0JsER tBAzuaictH6Wlc" style="padding: 8px 12px; background: linear-gradient(135deg, rgba(102, 126, 234, 0.05), rgba(118, 75, 162, 0.05)); border-left: 3px solid ${commentColor}; border-radius: 4px;">
                    <div style="display: flex; justify-content: space-between; align-items: center;">
                      <div>
                        <p style="color: #333; margin: 0; padding: 0; font-size: 14px; line-height: 1.4;">
                          <strong>Comment</strong> will be posted
                        </p>
                        <p style="color: #555; font-size: 13px; margin: 4px 0 0 0; font-style: italic;">
                          "${schedule.comment}"
                        </p>
                        <p style="color: #888; font-size: 12px; margin: 4px 0 0 0;">
                          Scheduled for ${schedTime.toLocaleString()}
                        </p>
                      </div>
                      <button class="cancel-scheduled-btn ybVBgfOiuWZJtD _St8_YSRMkLv07"
                              style="padding: 4px 8px; font-size: 12px; margin-left: 12px;">
                        Cancel
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        `;

        // Add cancel button functionality
        const cancelBtn = li.querySelector('.cancel-scheduled-btn');
        if (cancelBtn) {
          cancelBtn.addEventListener('click', async (e) => {
            e.preventDefault();
            e.stopPropagation();

            if (confirm('Cancel this scheduled comment?')) {
              // Cancel from worker KV if we have the key
              if (schedule.kvKey) {
                try {
                  const token = getTrelloToken(); if (!token) { alert('Please set your Trello token first - see README'); return; }
                  const response = await fetch(`${WORKER_URL}/cancel`, {
                    method: 'POST',
                    headers: {
                      'Content-Type': 'application/json',
                    },
                    body: JSON.stringify({
                      key: schedule.kvKey,
                      trelloToken: token
                    })
                  });
                } catch (error) {
                  // Handle silently
                }
              } else {
                alert('WARNING: This item was scheduled before the cancellation fix. It may still execute even though removed from display!');
              }

              // Remove from local storage
              const key = `scheduled_comments_${cardId}`;
              const currentComments = JSON.parse(localStorage.getItem(key) || '[]');
              const filtered = currentComments.filter(s =>
                !(s.scheduledTime === schedule.scheduledTime && s.comment === schedule.comment)
              );
              localStorage.setItem(key, JSON.stringify(filtered));

              // Remove from DOM immediately
              li.remove();
            }
          });
        }

        // Insert into activity feed
        const firstActivity = commentThread.querySelector('li[data-testid="card-back-action"]:not(.scheduled-comment-item):not(.scheduled-completion-item)');
        if (firstActivity) {
          firstActivity.insertAdjacentElement('beforebegin', li);
        } else {
          commentThread.appendChild(li);
        }
      }
    });

    // Display scheduled completions
    updateScheduledCompletionDisplaysInThread(commentThread);
  }

  // Function to display scheduled completions in the comment thread
  function updateScheduledCompletionDisplays() {
    // Find the comment thread container (activity list) - try multiple selectors
    const selectors = [
      '.VxKRIoztMcODIj',
      'ul.card-back-redesign',
      '[data-testid="card-back-activity-list"]',
      '.js-list-actions',
      '.phenom-list',
      '.js-card-detail-activities-list',
      '.mod-card-back-activity ul',
      '.window-module .phenom'
    ];

    let commentThread = null;
    for (const selector of selectors) {
      commentThread = document.querySelector(selector);
      if (commentThread) {
        break;
      }
    }

    if (!commentThread) {
      // Try to find any UL that contains card actions or phenom items
      const actionItem = document.querySelector('li[data-testid="card-back-action"], .phenom');
      if (actionItem) {
        commentThread = actionItem.closest('ul');
      }
    }

    if (!commentThread) {
      // Last attempt - find any UL element within the activity section
      const activitySection = document.querySelector('[data-testid="card-back-activity"], .js-card-detail-activity, .window-module.activity');
      if (activitySection) {
        commentThread = activitySection.querySelector('ul');
      }
    }

    if (!commentThread) {
      return;
    }

    updateScheduledCompletionDisplaysInThread(commentThread);
  }

  function updateScheduledCompletionDisplaysInThread(commentThread) {
    // Remove existing scheduled completion displays
    document.querySelectorAll('.scheduled-completion-item').forEach(el => el.remove());

    // Get scheduled completions for this card
    const cardId = window.location.pathname.match(/\/c\/([a-zA-Z0-9]+)/)?.[1];
    if (!cardId) {
      return;
    }

    const allItems = JSON.parse(localStorage.getItem('scheduledCompletions') || '[]');
    const scheduledItems = allItems.filter(item => item.cardId === cardId);

    // Display each scheduled completion
    scheduledItems.forEach(item => {
      const scheduledDate = new Date(item.scheduledTime);
      const now = new Date();

      // Only show future scheduled items
      if (scheduledDate > now) {
        // Calculate time until scheduled
        const timeDiff = scheduledDate - now;
        const hours = Math.floor(timeDiff / (1000 * 60 * 60));
        const minutes = Math.floor((timeDiff % (1000 * 60 * 60)) / (1000 * 60));

        let timeString;
        if (hours > 24) {
          const days = Math.floor(hours / 24);
          timeString = `in ${days} day${days > 1 ? 's' : ''}`;
        } else if (hours > 0) {
          timeString = `in ${hours} hour${hours > 1 ? 's' : ''}`;
        } else {
          timeString = `in ${minutes} minute${minutes !== 1 ? 's' : ''}`;
        }

        // Determine the type and icon
        let typeLabel = 'Scheduled Completion';
        let iconColor = '#4CAF50';
        let description = item.itemDescription;

        if (item.itemDescription === 'Card completion status') {
          typeLabel = 'Scheduled Card Status';
          iconColor = '#FF9800';
          description = 'Card';
        }

        const completionLi = document.createElement('li');
        completionLi.className = 'tHtuAoy3OW7uUR scheduled-completion-item';
        completionLi.setAttribute('data-testid', 'card-back-action');

        completionLi.innerHTML = `
          <div>
            <button class="w7KETlmrCN8Ekc PkNmqmQLu48HSf ybVBgfOiuWZJtD _St8_YSRMkLv07" type="button" title="${typeLabel}" tabindex="0" aria-expanded="false">
              <span class="scheduled-avatar" style="display: inline-flex; align-items: center; justify-content: center; background: ${iconColor}; color: white; height: 32px; width: 32px; border-radius: 50%; font-size: 16px;">
                ${item.markComplete ? '✓' : '○'}
              </span>
            </button>
          </div>
          <div class="xFvhqhjs5Kc6GV" data-testid="card-back-action-container">
            <div>
              <span class="DeB_YZayTLAXDU">
                <span class="Ai3iz3ksdQJNLc">
                  <span class="Gn87mV4xr5HQJh" style="color: ${iconColor}; font-style: italic;">${typeLabel}</span>
                </span>
              </span>
              <span class="iqpuBPSRgp54GF cMjKAsoVQYsKab" style="color: #888;">
                <span title="${scheduledDate.toLocaleString()}">${timeString}</span>
              </span>
            </div>
            <div class="l4lQedPGf8KN1w" role="button">
              <div class="_4MrlvXRZe6dnu" data-testid="comment-container">
                <div class="R1RfC8jJFTMJlv Xfg5GTUiZ1tTRp" style="opacity: 0.85;">
                  <div class="hPERvAPxokg05x Ijf59q3IL0JsER tBAzuaictH6Wlc" style="padding: 8px 12px; background: linear-gradient(135deg, rgba(102, 126, 234, 0.05), rgba(118, 75, 162, 0.05)); border-left: 3px solid ${iconColor}; border-radius: 4px;">
                    <div style="display: flex; justify-content: space-between; align-items: center;">
                      <div>
                        <p style="color: #333; margin: 0; padding: 0; font-size: 14px; line-height: 1.4;">
                          <strong>${description}</strong> will be ${item.markComplete ? 'marked complete' : 'marked incomplete'}
                        </p>
                        <p style="color: #888; font-size: 12px; margin: 4px 0 0 0;">
                          Scheduled for ${scheduledDate.toLocaleString()}
                        </p>
                      </div>
                      <button class="cancel-scheduled-completion ybVBgfOiuWZJtD _St8_YSRMkLv07"
                              data-item="${btoa(JSON.stringify(item))}"
                              style="padding: 4px 8px; font-size: 12px; margin-left: 12px;">
                        Cancel
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        `;

        // Add cancel functionality
        completionLi.querySelector('.cancel-scheduled-completion').addEventListener('click', async function(e) {
          e.preventDefault();
          e.stopPropagation();

          if (confirm('Cancel this scheduled completion?')) {
            const itemData = JSON.parse(atob(this.getAttribute('data-item')));

            // Cancel from worker KV if we have the key
            if (itemData.kvKey) {
              try {
                const token = getTrelloToken(); if (!token) { alert('Please set your Trello token first - see README'); return; }
                const response = await fetch(`${WORKER_URL}/cancel`, {
                  method: 'POST',
                  headers: {
                    'Content-Type': 'application/json',
                  },
                  body: JSON.stringify({
                    key: itemData.kvKey,
                    trelloToken: token
                  })
                });
              } catch (error) {
                // Handle silently
              }
            } else {
              alert('WARNING: This completion was scheduled before the cancellation fix. It may still execute even though removed from display!');
            }

            // Remove from local storage
            const items = JSON.parse(localStorage.getItem('scheduledCompletions') || '[]');
            const filtered = items.filter(i =>
              !(i.cardId === itemData.cardId &&
                i.scheduledTime === itemData.scheduledTime &&
                i.itemDescription === itemData.itemDescription)
            );
            localStorage.setItem('scheduledCompletions', JSON.stringify(filtered));
            completionLi.remove();
          }
        });

        // Insert into activity feed - find the right place to insert
        // Insert after scheduled comments but before regular activities
        const scheduledComments = commentThread.querySelector('.scheduled-comment-item');
        if (scheduledComments) {
          // Insert after last scheduled comment
          let lastScheduled = scheduledComments;
          let nextSibling = scheduledComments.nextElementSibling;
          while (nextSibling && nextSibling.classList.contains('scheduled-comment-item')) {
            lastScheduled = nextSibling;
            nextSibling = nextSibling.nextElementSibling;
          }
          lastScheduled.insertAdjacentElement('afterend', completionLi);
        } else {
          // Insert at the beginning of the activity feed
          const firstActivity = commentThread.querySelector('li[data-testid="card-back-action"]:not(.scheduled-comment-item):not(.scheduled-completion-item)');
          if (firstActivity) {
            firstActivity.insertAdjacentElement('beforebegin', completionLi);
          } else {
            commentThread.appendChild(completionLi);
          }
        }

      } else {
        // Skip past item
      }
    });
  }


  // Clean up legacy scheduled items that don't have KV keys (can't be canceled properly)
  function cleanupLegacyScheduledItems() {
    // Clean comments
    const commentKeys = Object.keys(localStorage).filter(key => key.startsWith('scheduled_comments_'));
    commentKeys.forEach(key => {
      const comments = JSON.parse(localStorage.getItem(key) || '[]');
      const hasLegacy = comments.some(c => !c.kvKey);
      if (hasLegacy) {
        const withKeys = comments.filter(c => c.kvKey);
        localStorage.setItem(key, JSON.stringify(withKeys));
      }
    });

    // Clean completions
    const completions = JSON.parse(localStorage.getItem('scheduledCompletions') || '[]');
    const legacyCompletions = completions.filter(c => !c.kvKey);
    if (legacyCompletions.length > 0) {
      const withKeys = completions.filter(c => c.kvKey);
      localStorage.setItem('scheduledCompletions', JSON.stringify(withKeys));
    }
  }

  // Initialize and observe for changes
  function initialize() {
    // Clean up any legacy items that can't be properly canceled
    cleanupLegacyScheduledItems();

    // Initial display update
    updateScheduledItemsDisplay();

    // Process every 2 seconds to catch dynamically loaded content (reduced frequency)
    const processInterval = setInterval(() => {
      processCommentComposers();
      processDueDateCheckboxes();
      processMarkCompleteButton();
      updateScheduledItemsDisplay();
    }, 2000);

    // Also use MutationObserver for immediate updates
    const observer = new MutationObserver((mutations) => {
      // Check if any mutations added nodes with our target selectors
      for (const mutation of mutations) {
        if (mutation.addedNodes.length > 0) {
          processCommentComposers();
          processDueDateCheckboxes();
          processMarkCompleteButton();
          // Update scheduled displays when new content is added (like opening a card)
          setTimeout(() => updateScheduledItemsDisplay(), 100);
        }
      }
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true
    });

    // Listen for URL changes (when navigating between cards)
    let currentUrl = window.location.href;
    setInterval(() => {
      if (window.location.href !== currentUrl) {
        currentUrl = window.location.href;
        // URL changed, likely navigated to a different card
        setTimeout(() => updateScheduledItemsDisplay(), 200);
      }
    }, 1000);

    // Also update when window regains focus
    window.addEventListener('focus', () => {
      setTimeout(() => updateScheduledItemsDisplay(), 100);
    });

    // Stop interval after 30 seconds to avoid performance issues
    setTimeout(() => {
      clearInterval(processInterval);
    }, 30000);
  }

  // Wait for Trello to load
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      setTimeout(initialize, 2000); // Wait for React to render
    });
  } else {
    // Add a delay to ensure Trello React app has initialized
    setTimeout(initialize, 2000);
  }
})();
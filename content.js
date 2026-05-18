let isRunning = false;
let profile = {};
let filters = {};

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.action === 'startApply') {
    profile = { ...msg.profile, autoSubmit: true }; // single job → auto-submit
    isRunning = true;
    startEasyApply().catch(err => notify('error', err.message));
    sendResponse({ ok: true });
  }
  if (msg.action === 'batchApply') {
    profile  = { ...msg.profile, autoSubmit: true }; // batch always auto-submits
    filters  = msg.filters || {};
    isRunning = true;
    batchApplyAll().catch(err => notify('error', err.message));
    sendResponse({ ok: true });
  }
  if (msg.action === 'stopApply') {
    isRunning = false;
    sendResponse({ ok: true });
  }
  return true;
});

// ─── Batch Entry Point ────────────────────────────────────────────────────────

async function batchApplyAll() {
  const cards = getJobCards();
  if (!cards.length) {
    log('No job cards found. Make sure you are on a LinkedIn Jobs search page.', 'error');
    notify('error', 'No job cards found on this page.');
    return;
  }

  const appliedIds = await getAppliedIds();
  let applied = 0, skipped = 0, failed = 0;
  const total = cards.length;

  log(`Found ${total} jobs on page. Starting batch apply...`, 'info');
  sendProgress(applied, skipped, failed, total);

  for (const card of cards) {
    if (!isRunning) { log('Stopped by user.', 'warn'); break; }

    const jobId    = getJobId(card);
    const jobTitle = getJobTitle(card);
    const company  = getJobCompany(card);

    // Skip: already applied (our own record)
    if (jobId && appliedIds.has(String(jobId))) {
      log(`Skip (already applied): ${jobTitle}`, 'warn');
      skipped++; sendProgress(applied, skipped, failed, total); continue;
    }

    // Skip: LinkedIn "Applied" badge on card
    if (hasAppliedBadge(card)) {
      log(`Skip (Applied badge): ${jobTitle}`, 'warn');
      if (jobId) { appliedIds.add(String(jobId)); await saveAppliedIds(appliedIds); }
      skipped++; sendProgress(applied, skipped, failed, total); continue;
    }

    // Skip: doesn't match title/keyword filters
    if (!matchesFilters(jobTitle, company, card)) {
      log(`Skip (filters): ${jobTitle}`, 'info');
      skipped++; sendProgress(applied, skipped, failed, total); continue;
    }

    // Open the job card
    log(`Opening: ${jobTitle} @ ${company}`, 'info');
    const cardLink = card.querySelector('a[href*="/jobs/view/"], .job-card-container__link, .job-card-list__title, a[href*="linkedin.com/jobs"]');
    if (cardLink) await humanClick(cardLink); else await humanClick(card);
    await jitterDelay(1800, 0.3);

    // Check for Easy Apply button
    const easyBtn = findEasyApplyButton();
    if (!easyBtn) {
      log(`Skip (no Easy Apply): ${jobTitle}`, 'warn');
      skipped++; sendProgress(applied, skipped, failed, total); continue;
    }

    // Apply
    try {
      log(`Applying: ${jobTitle} @ ${company}`, 'info');
      await humanClick(easyBtn);
      await jitterDelay(1500, 0.3);
      await runApplicationFlow();

      if (jobId) { appliedIds.add(String(jobId)); await saveAppliedIds(appliedIds); }
      applied++;
      log(`✓ Applied: ${jobTitle}`, 'success');
    } catch (err) {
      log(`✗ Failed: ${jobTitle} — ${err.message}`, 'error');
      failed++;
      await dismissAnyModal();
    }

    sendProgress(applied, skipped, failed, total);

    // Human-like gap between applications: 4–7 seconds
    if (isRunning) await jitterDelay(5000, 0.35);
  }

  const summary = `Done! Applied: ${applied} | Skipped: ${skipped} | Failed: ${failed}`;
  log(summary, 'success');
  chrome.runtime.sendMessage({ type: 'batchDone', applied, skipped, failed, total });
}

// ─── Single Job Entry Point ───────────────────────────────────────────────────

async function startEasyApply() {
  const btn = findEasyApplyButton();
  if (!btn) {
    notify('error', 'No Easy Apply button found on this page.');
    return;
  }
  log('Clicking Easy Apply...', 'info');
  await humanClick(btn);
  await jitterDelay(1500, 0.3);
  await runApplicationFlow();
}

// ─── Job Card Helpers ─────────────────────────────────────────────────────────

function getJobCards() {
  // Strategy 1: data attributes (older LinkedIn)
  for (const attr of ['data-occludable-job-id', 'data-job-id']) {
    const els = [...document.querySelectorAll(`[${attr}]`)];
    if (els.length) {
      const cards = [...new Set(els.map(el => el.closest('li') || el.closest('div') || el))];
      log(`Found ${cards.length} cards via [${attr}]`, 'info');
      return cards;
    }
  }

  // Strategy 2: LinkedIn now uses hashed class names — find cards by job links
  // Walk up from each job link to find the card container (sibling cards share the same parent)
  const jobLinks = [...document.querySelectorAll('a[href*="/jobs/view/"]')];
  if (jobLinks.length) {
    // Find the shared list container by walking up from the first link
    // until we hit an element with multiple children that each contain a job link
    let container = jobLinks[0].parentElement;
    for (let depth = 0; depth < 12; depth++) {
      if (!container || container === document.body) break;
      const childrenWithLinks = [...container.children].filter(c =>
        c.querySelector('a[href*="/jobs/view/"]')
      );
      if (childrenWithLinks.length >= 1 && container.children.length >= 1) {
        // Found the list — each child with a job link is a card
        if (childrenWithLinks.length === jobLinks.length || childrenWithLinks.length > 1) {
          log(`Found ${childrenWithLinks.length} cards via job-link container (depth ${depth})`, 'info');
          return childrenWithLinks;
        }
      }
      container = container.parentElement;
    }

    // Fallback: return the closest sizeable ancestor of each link
    const cards = [...new Set(jobLinks.map(link => {
      let el = link.parentElement;
      for (let i = 0; i < 8; i++) {
        if (!el || el === document.body) break;
        if (el.offsetHeight > 60 && el.offsetWidth > 100) return el;
        el = el.parentElement;
      }
      return link.parentElement;
    }))];
    log(`Found ${cards.length} cards via link-ancestor fallback`, 'info');
    return cards;
  }

  log(`No job cards found. job links=${document.querySelectorAll('a[href*="/jobs/view/"]').length}`, 'warn');
  return [];
}

function getJobId(card) {
  // Check the card itself and any child with a job ID attribute
  return card.dataset.occludableJobId
    || card.dataset.jobId
    || card.querySelector('[data-occludable-job-id]')?.dataset.occludableJobId
    || card.querySelector('[data-job-id]')?.dataset.jobId
    || card.querySelector('a[href*="/jobs/view/"]')?.href.match(/\/jobs\/view\/(\d+)/)?.[1]
    || null;
}

function getJobTitle(card) {
  return (
    card.querySelector('.job-card-list__title, .job-card-container__link')?.textContent.trim()
    || card.querySelector('a[href*="/jobs/view/"]')?.textContent.trim()
    || card.querySelector('strong, h3, h4')?.textContent.trim()
    || 'Unknown Title'
  );
}

function getJobCompany(card) {
  return (
    card.querySelector('.job-card-container__company-name, .artdeco-entity-lockup__subtitle, .job-card-container__primary-description')?.textContent.trim()
    || ''
  );
}

function hasAppliedBadge(card) {
  const text = card.textContent || '';
  return /\bapplied\b/i.test(
    card.querySelector('.job-card-container__footer-job-state, .artdeco-inline-feedback, [class*="footer-job-state"]')?.textContent || ''
  );
}

function matchesFilters(title, company, card) {
  const t = title.toLowerCase();
  const c = company.toLowerCase();

  // Must contain at least one include keyword (if set)
  if (filters.includeKeywords) {
    const includes = filters.includeKeywords.split(',').map(k => k.trim().toLowerCase()).filter(Boolean);
    if (includes.length && !includes.some(k => t.includes(k) || c.includes(k))) return false;
  }

  // Must NOT contain any exclude keyword
  if (filters.excludeKeywords) {
    const excludes = filters.excludeKeywords.split(',').map(k => k.trim().toLowerCase()).filter(Boolean);
    if (excludes.some(k => t.includes(k) || c.includes(k))) return false;
  }

  // Remote filter: check card text / job metadata
  if (filters.remoteOnly) {
    const cardText = card.textContent.toLowerCase();
    if (!/remote|work from home|wfh/.test(cardText)) return false;
  }

  return true;
}

// ─── Applied IDs Store ────────────────────────────────────────────────────────

async function getAppliedIds() {
  return new Promise(resolve => {
    chrome.storage.local.get('appliedJobs', d => {
      resolve(new Set(d.appliedJobs || []));
    });
  });
}

async function saveAppliedIds(set) {
  return new Promise(resolve => {
    chrome.storage.local.set({ appliedJobs: [...set] }, resolve);
  });
}

// ─── Application Flow ─────────────────────────────────────────────────────────

async function runApplicationFlow() {
  let stepCount = 0;
  const maxSteps = 20;

  while (isRunning && stepCount < maxSteps) {
    stepCount++;
    await jitterDelay(profile.stepDelay || 900, 0.35);

    const modal = getModal();
    if (!modal) { log('Modal closed.', 'warn'); break; }

    const primaryBtn = getPrimaryButton(modal);
    if (!primaryBtn) { log('No action button in modal.', 'warn'); break; }

    const btnText = primaryBtn.textContent.trim().toLowerCase();
    log(`Step ${stepCount}: "${primaryBtn.textContent.trim()}"`, 'info');

    await fillCurrentStep(modal);
    await jitterDelay(600, 0.5);

    if (btnText.includes('submit application')) {
      if (profile.autoSubmit) {
        log('Submitting...', 'info');
        await humanClick(primaryBtn);
        await jitterDelay(2000, 0.2);
        handlePostSubmit();
        break;
      } else {
        log('Paused at review — submit manually.', 'warn');
        notify('status', 'Review & Submit');
        break;
      }
    } else if (/review|next|continue/.test(btnText)) {
      await humanClick(primaryBtn);
      await jitterDelay(1100, 0.3);
    } else {
      log(`Unknown button "${primaryBtn.textContent.trim()}", stopping.`, 'warn');
      break;
    }
  }

  if (stepCount >= maxSteps) log('Max steps reached.', 'warn');
}

// ─── Modal & Button Helpers ───────────────────────────────────────────────────

function findEasyApplyButton() {
  // Class-based (most reliable)
  const byClass = document.querySelector(
    '.jobs-apply-button--top-card button, button.jobs-apply-button, .jobs-apply-button'
  );
  if (byClass && !byClass.disabled) return byClass;

  // aria-label contains Apply
  const byAria = [...document.querySelectorAll('button[aria-label]')].find(b =>
    /apply/i.test(b.getAttribute('aria-label')) && !b.disabled
  );
  if (byAria) return byAria;

  // Text match — "Apply", "LinkedIn Apply", "Easy Apply"
  return [...document.querySelectorAll('button')].find(b => {
    const t = b.textContent.trim();
    return /^(Apply|LinkedIn Apply|Easy Apply)$/i.test(t) && !b.disabled;
  }) || null;
}

function getModal() {
  return (
    document.querySelector('.jobs-easy-apply-modal') ||
    document.querySelector('.jobs-linkedin-apply-modal') ||
    document.querySelector('[data-test-modal-id="easy-apply-modal"]') ||
    document.querySelector('[data-test-modal-id="linkedin-apply-modal"]') ||
    document.querySelector('.artdeco-modal[role="dialog"]')
  );
}

function getPrimaryButton(modal) {
  const btn = modal.querySelector('.artdeco-button--primary');
  if (btn && !btn.disabled) return btn;
  return [...modal.querySelectorAll('button')].find(b => {
    const t = b.textContent.trim().toLowerCase();
    return (t.includes('next') || t.includes('review') || t.includes('submit')) && !b.disabled;
  }) || null;
}

async function dismissAnyModal() {
  const closeBtn = document.querySelector(
    '.artdeco-modal__dismiss, button[aria-label="Dismiss"], button[aria-label="Cancel"]'
  );
  if (closeBtn) {
    await humanClick(closeBtn);
    await jitterDelay(600, 0.3);
    // Confirm discard if prompted
    await jitterDelay(400, 0.3);
    const discardBtn = document.querySelector('button[data-control-name="discard_application_confirm_btn"]');
    if (discardBtn) await humanClick(discardBtn);
  }
}

// ─── Step Filler ──────────────────────────────────────────────────────────────

async function fillCurrentStep(modal) {
  const inputs = [...modal.querySelectorAll(
    'input:not([type="hidden"]):not([type="file"]):not([type="radio"]):not([type="checkbox"]), select, textarea'
  )];

  for (const input of inputs) {
    if (!isRunning) break;
    if (!isVisible(input)) continue;
    const label = getLabelText(input, modal);
    if (!label) continue;

    if (input.tagName === 'SELECT') await fillSelect(input, label);
    else await fillTextInput(input, label);

    await jitterDelay(180, 0.5);
  }

  await fillCheckboxes(modal);
  await fillRadioGroups(modal);
}

function isVisible(el) {
  if (!el.offsetParent && el.tagName !== 'BODY') return false;
  const s = window.getComputedStyle(el);
  return s.display !== 'none' && s.visibility !== 'hidden' && s.opacity !== '0';
}

// ─── Label Detection ──────────────────────────────────────────────────────────

function getLabelText(input, modal) {
  if (input.id) {
    const lbl = modal.querySelector(`label[for="${CSS.escape(input.id)}"]`);
    if (lbl) return lbl.textContent.trim();
  }
  const parentLabel = input.closest('label');
  if (parentLabel) return parentLabel.textContent.trim();
  if (input.getAttribute('aria-label')) return input.getAttribute('aria-label').trim();
  if (input.getAttribute('aria-labelledby')) {
    const ref = document.getElementById(input.getAttribute('aria-labelledby'));
    if (ref) return ref.textContent.trim();
  }
  if (input.placeholder) return input.placeholder.trim();
  const container = input.closest(
    '.fb-dash-form-element, .jobs-easy-apply-form-element, .jobs-linkedin-apply-form-element, [class*="form-element"], fieldset, .artdeco-text-input'
  );
  if (container) {
    const text = container.querySelector('label, legend, .fb-dash-form-element__label, [class*="label"]');
    if (text) return text.textContent.trim();
  }
  return input.name || '';
}

// ─── Field Fillers ────────────────────────────────────────────────────────────

async function fillTextInput(input, label) {
  if (input.value && input.value.trim()) return;
  const val = resolveAnswer(label, input);
  if (!val) return;
  log(`Typing "${truncate(label)}" → "${truncate(String(val))}"`, 'info');
  await scrollTo(input);
  await humanFocus(input);
  await simulateTyping(input, String(val));
  input.dispatchEvent(new Event('blur', { bubbles: true }));
  await jitterDelay(80, 0.5);
}

async function fillSelect(select, label) {
  if (select.value && select.value !== '' && !/select an option/i.test(select.value)) return;
  const options = [...select.options].filter(o => o.value !== '' && !o.disabled);
  if (!options.length) return;

  const answer = resolveAnswer(label, select);
  let chosen = null;

  if (answer !== null && answer !== undefined) {
    const ansStr = String(answer).toLowerCase();
    chosen = options.find(o => o.value.toLowerCase() === ansStr || o.text.toLowerCase() === ansStr);
    if (!chosen && /^(yes|true|1)$/i.test(ansStr)) chosen = options.find(o => /^yes$/i.test(o.text.trim()));
    if (!chosen && /^(no|false|0)$/i.test(ansStr)) chosen = options.find(o => /^no$/i.test(o.text.trim()));
    if (!chosen && /year/i.test(label)) chosen = findClosestYearOption(options, parseInt(answer));
    if (!chosen) chosen = options.find(o => o.text.toLowerCase().includes(ansStr));
  }
  if (!chosen) {
    chosen = options.find(o => /^yes$/i.test(o.text.trim()))
          || options.find(o => !/^(select|choose|please select)/i.test(o.text.trim()) && o.value && o.text.trim())
          || options[0];
  }

  log(`Selecting "${truncate(label)}" → "${chosen.text}"`, 'info');
  await scrollTo(select);
  await jitterDelay(200, 0.4);
  select.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
  await jitterDelay(120, 0.3);
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set;
  if (setter) setter.call(select, chosen.value); else select.value = chosen.value;
  select.dispatchEvent(new Event('change', { bubbles: true }));
  select.dispatchEvent(new Event('blur', { bubbles: true }));
}

function findClosestYearOption(options, years) {
  let best = null, bestDiff = Infinity;
  for (const opt of options) {
    const nums = opt.text.match(/\d+/g);
    if (!nums) continue;
    const mid = nums.length > 1 ? (parseInt(nums[0]) + parseInt(nums[1])) / 2 : parseInt(nums[0]);
    const diff = Math.abs(mid - years);
    if (diff < bestDiff) { bestDiff = diff; best = opt; }
  }
  return best;
}

async function fillRadioGroups(modal) {
  const seen = new Set();
  for (const radio of modal.querySelectorAll('input[type="radio"]')) {
    if (!radio.name || seen.has(radio.name)) continue;
    seen.add(radio.name);

    const group = [...modal.querySelectorAll(`input[name="${CSS.escape(radio.name)}"]`)];
    if (group.some(r => r.checked)) continue;

    const label = getRadioGroupLabel(radio, modal);
    const answer = resolveAnswer(label || radio.name, radio);
    let target = null;

    if (answer !== null && answer !== undefined) {
      const ansStr = String(answer).toLowerCase();
      target = group.find(r => {
        const lbl = getLabelText(r, modal).toLowerCase().trim();
        return lbl === ansStr
          || (ansStr === 'yes' && /^yes$/i.test(lbl))
          || (ansStr === 'no'  && /^no$/i.test(lbl));
      });
    }

    if (!target && isYesNoGroup(group, modal)) {
      const wantNo = (/sponsor/.test(label) && !profile.requireSponsorship)
                  || (/relocat/.test(label)  && !profile.willingToRelocate);
      target = group.find(r => {
        const lbl = getLabelText(r, modal).toLowerCase().trim();
        return wantNo ? /^no$/.test(lbl) : /^yes$/.test(lbl);
      });
    }

    if (!target) target = group[0];

    if (target) {
      log(`Radio "${truncate(label)}" → "${getLabelText(target, modal)}"`, 'info');
      await scrollTo(target);
      await jitterDelay(200, 0.4);
      await humanClick(target);
      await jitterDelay(150, 0.4);
    }
  }
}

function getRadioGroupLabel(radio, modal) {
  const fieldset = radio.closest('fieldset');
  if (fieldset) {
    const legend = fieldset.querySelector('legend');
    if (legend) return legend.textContent.trim();
  }
  const container = radio.closest('[class*="form-element"], [class*="form-group"], .fb-dash-form-element');
  if (container) {
    const lbl = container.querySelector('label:not([for]), legend, span[class*="label"]');
    if (lbl) return lbl.textContent.trim();
  }
  return getLabelText(radio, modal);
}

function isYesNoGroup(radios, modal) {
  const labels = radios.map(r => getLabelText(r, modal).toLowerCase().trim());
  return labels.some(l => /^yes$/.test(l)) && labels.some(l => /^no$/.test(l));
}

async function fillCheckboxes(modal) {
  for (const cb of modal.querySelectorAll('input[type="checkbox"]')) {
    if (!isVisible(cb)) continue;
    const label = getLabelText(cb, modal);
    if (/agree|terms|privacy|consent|policy/i.test(label) && !cb.checked) {
      log(`Checking consent: "${truncate(label)}"`, 'warn');
      await scrollTo(cb);
      await jitterDelay(300, 0.4);
      await humanClick(cb);
    }
  }
}

// ─── Answer Resolver ──────────────────────────────────────────────────────────

function resolveAnswer(label, input) {
  const l = label.toLowerCase();

  if (/\bfirst.?name\b/.test(l))                                    return profile.fullName?.split(' ')[0] || '';
  if (/\blast.?name\b|surname/.test(l))                             return profile.fullName?.split(' ').slice(1).join(' ') || '';
  if (/\bfull.?name\b|\bname\b/.test(l) && !/company|employer/.test(l)) return profile.fullName || '';
  if (/\bemail\b/.test(l))                                          return profile.email || '';
  if (/\bphone\b|\bmobile\b|\bcontact.?number\b/.test(l))          return profile.phone || '';
  if (/\bcity\b|\blocation\b|\bwhere.?based\b/.test(l))            return profile.city || '';
  if (/current.?title|job.?title|\brole\b/i.test(l))               return profile.currentTitle || '';
  if (/current.?company|employer|organization/i.test(l))           return profile.currentCompany || '';
  if (/linkedin/i.test(l))                                          return profile.linkedinUrl || '';
  if (/\bwebsite\b|\bportfolio\b|\bgithub\b/i.test(l))             return profile.websiteUrl || '';
  if (/years?\s*(of\s*)?(total\s*)?experience|experience.*years?/i.test(l)) return profile.yearsOfExperience || '';
  if (/years?\s*in\s*(current|this)/i.test(l))                     return Math.min(parseInt(profile.yearsOfExperience) || 2, 3);
  if (/years?.*relevant|relevant.*years?/i.test(l))                return profile.yearsOfExperience || '';
  if (/salary|compensation|\bctc\b|\bpay\b|package/i.test(l))     return profile.expectedSalary || '';
  if (/notice.?period|when.*start|available.*start/i.test(l)) {
    // Number fields expect days — convert "1 month" → 30, "2 weeks" → 14, etc.
    if (input && (input.type === 'number' || input.getAttribute('inputmode') === 'numeric' || input.step)) {
      const val = profile.noticePeriod || '1 month';
      if (/immediate|0/i.test(val)) return '0';
      const num = parseInt(val.match(/\d+/)?.[0] || '1');
      if (/week/i.test(val)) return String(num * 7);
      if (/month/i.test(val)) return String(num * 30);
      return String(num);
    }
    return profile.noticePeriod || '1 month';
  }
  if (/education|degree|qualification/i.test(l))                   return profile.education || "Bachelor's Degree";
  if (/authoriz.*work|legally.*work|work.*permit|eligible.*work/i.test(l)) return profile.workAuthorized ? 'Yes' : 'No';
  if (/visa.*sponsor|require.*sponsor|need.*sponsor/i.test(l))    return profile.requireSponsorship ? 'Yes' : 'No';
  if (/relocat/i.test(l))                                           return profile.willingToRelocate ? 'Yes' : 'No';
  if (/currently.*employ|present.*employ/i.test(l))                return profile.currentlyEmployed ? 'Yes' : 'No';
  if (/citizen|permanent.?resident/i.test(l))                      return 'Yes';
  if (/18\s*years|adult|legal.?age/i.test(l))                      return 'Yes';
  if (/drug.?test|background.?check/i.test(l))                     return 'Yes';
  if (/remote|hybrid|onsite/i.test(l))                             return 'Yes';
  if (/cover.?letter|motivat|introduction/i.test(l))               return buildCoverLetter();
  if (/\bgpa\b|grade\b|\bpercentage\b/i.test(l))                   return '8.0';

  return null;
}

function buildCoverLetter() {
  if (profile.coverLetter) return profile.coverLetter;
  return `I am excited to apply for this position. With ${profile.yearsOfExperience || 'several'} years of experience as a ${profile.currentTitle || 'professional'}, I have developed strong skills that align well with this role. I look forward to contributing to your team.`;
}

// ─── Human Simulation ─────────────────────────────────────────────────────────

async function simulateTyping(el, text) {
  el.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', ctrlKey: true, bubbles: true }));
  await jitterDelay(60, 0.5);
  el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true }));
  await jitterDelay(50, 0.5);

  const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;

  for (let i = 0; i < text.length; i++) {
    if (!isRunning) break;
    const char = text[i];
    el.dispatchEvent(new KeyboardEvent('keydown',  { key: char, bubbles: true }));
    el.dispatchEvent(new KeyboardEvent('keypress', { key: char, bubbles: true }));
    const next = text.slice(0, i + 1);
    if (setter) setter.call(el, next); else el.value = next;
    el.dispatchEvent(new InputEvent('input', { data: char, inputType: 'insertText', bubbles: true }));
    el.dispatchEvent(new KeyboardEvent('keyup', { key: char, bubbles: true }));
    await delay(Math.random() < 0.08 ? rand(200, 500) : rand(55, 145));
  }
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

async function humanFocus(el) {
  el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
  await jitterDelay(80, 0.5);
  el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
  await jitterDelay(50, 0.5);
  el.focus();
  el.dispatchEvent(new FocusEvent('focus', { bubbles: true }));
  await jitterDelay(80, 0.4);
}

async function humanClick(el) {
  await scrollTo(el);
  const rect = el.getBoundingClientRect();
  const x = rect.left + rect.width  * (0.35 + Math.random() * 0.3);
  const y = rect.top  + rect.height * (0.35 + Math.random() * 0.3);
  const opts = { bubbles: true, cancelable: true, clientX: x, clientY: y };
  el.dispatchEvent(new MouseEvent('mouseover',  opts));
  await jitterDelay(60, 0.5);
  el.dispatchEvent(new MouseEvent('mousedown', { ...opts, button: 0 }));
  await jitterDelay(rand(60, 140), 0.3);
  el.dispatchEvent(new MouseEvent('mouseup',   { ...opts, button: 0 }));
  el.dispatchEvent(new MouseEvent('click',     { ...opts, button: 0 }));
  await jitterDelay(60, 0.5);
}

async function scrollTo(el) {
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  await jitterDelay(250, 0.4);
}

function handlePostSubmit() {
  jitterDelay(1800, 0.3).then(() => {
    const btn = document.querySelector('button[aria-label="Dismiss"], .artdeco-modal__dismiss');
    if (btn) humanClick(btn);
  });
}

// ─── Messaging ────────────────────────────────────────────────────────────────

function sendProgress(applied, skipped, failed, total) {
  chrome.runtime.sendMessage({ type: 'progress', applied, skipped, failed, total });
}

function notify(type, text) {
  chrome.runtime.sendMessage({ type, text });
}

// ─── Utils ────────────────────────────────────────────────────────────────────

function rand(min, max)            { return Math.floor(Math.random() * (max - min + 1)) + min; }
function jitterDelay(base, pct)    { const d = base * (pct || 0.25); return delay(base + rand(-d, d)); }
function delay(ms)                 { return new Promise(r => setTimeout(r, Math.max(0, ms))); }
function truncate(s, n = 40)       { return s?.length > n ? s.slice(0, n) + '…' : s; }

function log(text, level = 'info') {
  console.log(`[EasyApplyBot] ${text}`);
  chrome.runtime.sendMessage({ type: 'log', text, level });
}

/**
 * Custom Product Bundler — Interactive Logic
 *
 * Handles:
 *  – Accordion open/close for each step
 *  – Variant swatch selection
 *  – Quantity increment / decrement on product cards
 *  – Syncing selected products to the Review panel
 *  – Quantity controls inside the Review panel
 *  – Price totals & savings calculation
 *  – localStorage persistence for selected products
 *  – Checkout (adds all items to Shopify cart via AJAX)
 */

(function () {
  'use strict';

  /* ========================================
     Constants
     ======================================== */
  const STORAGE_KEY = 'cpb_selected_products';

  /* ========================================
     State
     ======================================== */
  // selectedProducts is a Map keyed by a unique key: `${productId}__${variantId}`
  // Each value: { productId, variantId, title, blockTitle, stepIndex, quantity, price, comparePrice, image, selectedOptions }
  const selectedProducts = new Map();

  /* ========================================
     DOM References
     ======================================== */
  const section = document.querySelector('.cpb-section');
  if (!section) return;

  const stepsContainer = section.querySelector('.cpb-steps');
  const reviewItemsContainer = section.querySelector('#cpb-review-items');
  const reviewTotals = section.querySelector('#cpb-review-totals');
  const reviewActions = section.querySelector('#cpb-review-actions');
  const finalPriceEl = section.querySelector('#cpb-final-price');
  const originalPriceEl = section.querySelector('#cpb-original-price');
  const monthlyPriceEl = section.querySelector('#cpb-monthly-price');
  const savingsMessageEl = section.querySelector('#cpb-savings-message');
  const checkoutBtn = section.querySelector('#cpb-checkout-btn');

  /* ========================================
     Utility Helpers
     ======================================== */
  function moneyFormat(cents) {
    return '$' + (cents / 100).toFixed(2);
  }

  function getSelectedOptions(card) {
    const options = [];
    card.querySelectorAll('.cpb-product-card__option').forEach((optGroup) => {
      const active = optGroup.querySelector('.cpb-swatch--active');
      if (active) {
        options.push(active.dataset.value);
      }
    });
    return options;
  }

  function findMatchingVariant(card, selectedOptions) {
    const variantsJson = card.querySelector('.cpb-product-variants-json');
    if (!variantsJson) return null;
    try {
      const variants = JSON.parse(variantsJson.textContent);
      // Try to find an exact match
      const match = variants.find((v) => {
        return v.options.every((opt, i) => opt === selectedOptions[i]);
      });
      return match || variants[0];
    } catch {
      return null;
    }
  }

  function findVariantById(card, variantId) {
    const variantsJson = card.querySelector('.cpb-product-variants-json');
    if (!variantsJson) return null;
    try {
      const variants = JSON.parse(variantsJson.textContent);
      return variants.find((v) => String(v.id) === String(variantId)) || null;
    } catch {
      return null;
    }
  }

  function getProductKey(productId, variantId) {
    return `${productId}__${variantId}`;
  }

  /* ========================================
     localStorage Helpers
     ======================================== */
  function saveToStorage() {
    try {
      const data = [];
      for (const [key, entry] of selectedProducts) {
        data.push({ key, ...entry });
      }
      localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    } catch (e) {
      console.warn('CPB: Could not save to localStorage', e);
    }
  }

  function loadFromStorage() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const data = JSON.parse(raw);
      if (!Array.isArray(data)) return;

      data.forEach((item) => {
        if (item.key && item.productId && item.variantId && item.quantity > 0) {
          selectedProducts.set(item.key, {
            productId: item.productId,
            variantId: item.variantId,
            title: item.title || '',
            blockTitle: item.blockTitle || '',
            stepIndex: item.stepIndex || '1',
            quantity: item.quantity,
            price: item.price || 0,
            comparePrice: item.comparePrice || 0,
            image: item.image || '',
            selectedOptions: item.selectedOptions || [],
          });
        }
      });
    } catch (e) {
      console.warn('CPB: Could not load from localStorage', e);
    }
  }

  function clearStorage() {
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch (e) {
      console.warn('CPB: Could not clear localStorage', e);
    }
  }

  /**
   * After loading from localStorage, sync the UI:
   * – Set the correct swatch as active on each card
   * – Update the quantity display on each card
   * – Add the selected styling to cards with qty > 0
   */
  function restoreUIFromState() {
    for (const entry of selectedProducts.values()) {
      const card = section.querySelector(
        `.cpb-product-card[data-product-id="${entry.productId}"]`
      );
      if (!card) continue;

      // Restore swatch selections
      if (entry.selectedOptions && entry.selectedOptions.length > 0) {
        const optionGroups = card.querySelectorAll('.cpb-product-card__option');
        entry.selectedOptions.forEach((optValue, i) => {
          const group = optionGroups[i];
          if (!group) return;
          const swatches = group.querySelectorAll('.cpb-swatch');
          swatches.forEach((s) => s.classList.remove('cpb-swatch--active'));
          const match = group.querySelector(`.cpb-swatch[data-value="${CSS.escape(optValue)}"]`);
          if (match) {
            match.classList.add('cpb-swatch--active');
          }
        });
      }

      // Restore quantity display
      const qtyDisplay = card.querySelector('.cpb-qty-value');
      if (qtyDisplay) {
        qtyDisplay.textContent = entry.quantity;
      }

      // Add selected styling
      if (entry.quantity > 0) {
        card.classList.add('cpb-product-card--selected');
        const minusBtn = card.querySelector('.cpb-qty-btn--minus');
        if (minusBtn) updateMinusBtnState(minusBtn, entry.quantity);
      }

      // Update variant price display on card
      updateCardVariant(card);
    }

    // Update step counts and render review
    updateStepCounts();
    renderReview();
  }

  /* ========================================
     Accordion Logic (native <details>)
     ======================================== */
  function initAccordions() {
    const steps = stepsContainer.querySelectorAll('.cpb-step');
    steps.forEach((step) => {
      step.addEventListener('toggle', () => {
        // Optional: close other steps when one opens (exclusive accordion)
        if (step.open) {
          steps.forEach((s) => {
            if (s !== step && s.open) {
              s.open = false;
            }
          });
        }
      });
    });
  }

  function openStep(stepIndex) {
    const steps = stepsContainer.querySelectorAll('.cpb-step');
    steps.forEach((s) => {
      s.open = false;
    });
    const target = stepsContainer.querySelector(`.cpb-step[data-step-index="${stepIndex}"]`);
    if (target) {
      target.open = true;
      target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }

  /* ========================================
     Next-Step Buttons
     ======================================== */
  function initNextButtons() {
    section.querySelectorAll('.cpb-step__next-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const nextStep = parseInt(btn.dataset.nextStep, 10);
        openStep(nextStep);
      });
    });
  }

  /* ========================================
     Swatch Selection
     ======================================== */
  function initSwatches() {
    section.querySelectorAll('.cpb-product-card').forEach((card) => {
      card.querySelectorAll('.cpb-swatch').forEach((swatch) => {
        swatch.addEventListener('click', () => {
          // Deactivate siblings
          const parent = swatch.closest('.cpb-product-card__swatches');
          parent.querySelectorAll('.cpb-swatch').forEach((s) => s.classList.remove('cpb-swatch--active'));
          swatch.classList.add('cpb-swatch--active');

          // Update variant match & price display
          updateCardVariant(card);

          // If product is already in the bundle, update variant info
          updateExistingSelection(card);
        });
      });
    });
  }

  function updateCardVariant(card) {
    const selectedOptions = getSelectedOptions(card);
    const variant = findMatchingVariant(card, selectedOptions);
    if (!variant) return;

    // Update price display on card
    const priceEl = card.querySelector('.cpb-price--current');
    const compareEl = card.querySelector('.cpb-price--compare');
    if (priceEl) priceEl.textContent = moneyFormat(variant.price);
    if (compareEl) {
      if (variant.compare_at_price && variant.compare_at_price > variant.price) {
        compareEl.textContent = moneyFormat(variant.compare_at_price);
        compareEl.style.display = '';
      } else {
        compareEl.style.display = 'none';
      }
    }

    // Update "Save XX%" badge based on variant prices
    const badge = card.querySelector('.cpb-product-card__badge');
    if (variant.compare_at_price && variant.compare_at_price > variant.price) {
      const savePercent = Math.round(
        ((variant.compare_at_price - variant.price) / variant.compare_at_price) * 100
      );
      if (badge) {
        badge.textContent = `Save ${savePercent}%`;
        badge.style.display = '';
      } else {
        // Create badge if it doesn't exist yet
        const wrapper = card.querySelector('.cpb-product-card__image-wrapper');
        if (wrapper) {
          const newBadge = document.createElement('span');
          newBadge.className = 'cpb-product-card__badge';
          newBadge.textContent = `Save ${savePercent}%`;
          wrapper.appendChild(newBadge);
        }
      }
    } else {
      if (badge) badge.style.display = 'none';
    }

    // Update image if variant has one
    if (variant.featured_image) {
      const imgEl = card.querySelector('.cpb-product-card__image');
      if (imgEl && imgEl.tagName === 'IMG') {
        imgEl.src = variant.featured_image;
      }
    }

    // Store variant id on card
    card.dataset.currentVariantId = variant.id;
    card.dataset.currentVariantPrice = variant.price;
    card.dataset.currentVariantCompare = variant.compare_at_price || '';
  }

  function updateExistingSelection(card) {
    const productId = card.dataset.productId;
    const selectedOptions = getSelectedOptions(card);
    const variant = findMatchingVariant(card, selectedOptions);
    if (!variant) return;

    const newKey = getProductKey(productId, variant.id);

    // Check if the NEW variant already has an entry in the bundle
    const existingNewEntry = selectedProducts.get(newKey);
    const qtyDisplay = card.querySelector('.cpb-qty-value');
    const minusBtn = card.querySelector('.cpb-qty-btn--minus');

    if (existingNewEntry) {
      // Restore the quantity for this variant on the card
      if (qtyDisplay) qtyDisplay.textContent = existingNewEntry.quantity;
      card.classList.add('cpb-product-card--selected');
      if (minusBtn) updateMinusBtnState(minusBtn, existingNewEntry.quantity);
    } else {
      // New variant not yet in review — reset card to 0
      if (qtyDisplay) qtyDisplay.textContent = '0';
      card.classList.remove('cpb-product-card--selected');
      if (minusBtn) updateMinusBtnState(minusBtn, 0);
    }
  }

  /* ========================================
     Quantity Controls (Product Cards)
     ======================================== */
  function initQuantityControls() {
    section.querySelectorAll('.cpb-product-card').forEach((card) => {
      const minusBtn = card.querySelector('.cpb-qty-btn--minus');
      const plusBtn = card.querySelector('.cpb-qty-btn--plus');
      const qtyDisplay = card.querySelector('.cpb-qty-value');

      // Initialize variant data on card
      updateCardVariant(card);

      plusBtn.addEventListener('click', () => {
        let qty = parseInt(qtyDisplay.textContent, 10) || 0;
        qty++;
        qtyDisplay.textContent = qty;
        card.classList.add('cpb-product-card--selected');
        updateMinusBtnState(minusBtn, qty);
        syncCardToState(card, qty);
      });

      minusBtn.addEventListener('click', () => {
        let qty = parseInt(qtyDisplay.textContent, 10) || 0;
        if (qty <= 0) return;
        qty--;
        qtyDisplay.textContent = qty;
        if (qty === 0) {
          card.classList.remove('cpb-product-card--selected');
        }
        updateMinusBtnState(minusBtn, qty);
        syncCardToState(card, qty);
      });
    });
  }

  /**
   * Toggle filled style on minus button when qty >= 1
   */
  function updateMinusBtnState(minusBtn, qty) {
    if (qty >= 1) {
      minusBtn.classList.add('cpb-qty-btn--minus-active');
    } else {
      minusBtn.classList.remove('cpb-qty-btn--minus-active');
    }
  }

  function syncCardToState(card, qty) {
    const productId = card.dataset.productId;
    const selectedOptions = getSelectedOptions(card);
    const variant = findMatchingVariant(card, selectedOptions);
    if (!variant) return;

    const key = getProductKey(productId, variant.id);

    if (qty <= 0) {
      selectedProducts.delete(key);
    } else {
      selectedProducts.set(key, {
        productId,
        variantId: variant.id,
        title: card.dataset.productTitle,
        blockTitle: card.dataset.blockTitle,
        stepIndex: card.dataset.stepIndex,
        quantity: qty,
        price: variant.price,
        comparePrice: variant.compare_at_price || 0,
        image: variant.featured_image || card.dataset.productImage || '',
        selectedOptions,
      });
    }

    saveToStorage();
    updateStepCounts();
    renderReview();
  }

  /* ========================================
     Step Selected Counts
     ======================================== */
  function updateStepCounts() {
    const steps = stepsContainer.querySelectorAll('.cpb-step');
    steps.forEach((step) => {
      const stepIndex = step.dataset.stepIndex;
      let count = 0;
      for (const entry of selectedProducts.values()) {
        if (String(entry.stepIndex) === String(stepIndex)) {
          count += entry.quantity;
        }
      }
      const countEl = step.querySelector('.cpb-step__selected-count');
      if (countEl) {
        if (count > 0) {
          countEl.textContent = `${count} selected`;
          countEl.classList.add('has-count');
        } else {
          countEl.textContent = '';
          countEl.classList.remove('has-count');
        }
      }
    });
  }

  /* ========================================
     Render Review Panel
     ======================================== */
  function renderReview() {
    // Group by blockTitle
    const groups = {};
    for (const entry of selectedProducts.values()) {
      if (!groups[entry.blockTitle]) {
        groups[entry.blockTitle] = [];
      }
      groups[entry.blockTitle].push(entry);
    }

    const hasItems = selectedProducts.size > 0;

    if (!hasItems) {
      reviewItemsContainer.innerHTML = `
        <div class="cpb-review__empty">
          <p>No products added yet. Select products from the steps on the left.</p>
        </div>`;
      reviewTotals.style.display = 'none';
      reviewActions.style.display = 'none';
      return;
    }

    let html = '';
    for (const [groupName, items] of Object.entries(groups)) {
      html += `<div class="cpb-review__category">`;
      html += `<p class="cpb-review__category-label">${escapeHtml(groupName)}</p>`;
      items.forEach((item) => {
        const lineTotal = item.price * item.quantity;
        const lineCompare = item.comparePrice ? item.comparePrice * item.quantity : 0;
        const variantLabel = item.selectedOptions.length ? item.selectedOptions.join(' / ') : '';
        html += `
          <div class="cpb-review__item" data-review-key="${getProductKey(item.productId, item.variantId)}">
            <img src="${item.image || ''}" alt="" class="cpb-review__item-image" loading="lazy" width="40" height="40">
            <div class="cpb-review__item-info">
              <p class="cpb-review__item-name">${escapeHtml(item.title)}</p>
              ${variantLabel ? `<p class="cpb-review__item-variant">${escapeHtml(variantLabel)}</p>` : ''}
            </div>
            <div class="cpb-review__item-qty">
              <button type="button" class="cpb-review__qty-btn cpb-review__qty-minus" aria-label="Decrease quantity">−</button>
              <span class="cpb-review__qty-value">${item.quantity}</span>
              <button type="button" class="cpb-review__qty-btn cpb-review__qty-plus" aria-label="Increase quantity">+</button>
            </div>
            <div class="cpb-review__item-price">
              ${lineCompare > lineTotal ? `<span class="cpb-review__item-compare">${moneyFormat(lineCompare)}</span>` : ''}
              <span class="cpb-review__item-current">${moneyFormat(lineTotal)}</span>
            </div>
          </div>`;
      });
      html += `</div>`;
    }

    reviewItemsContainer.innerHTML = html;

    // Attach review quantity listeners
    initReviewQuantityControls();

    // Calculate totals
    calculateTotals();

    reviewTotals.style.display = '';
    reviewActions.style.display = '';
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.appendChild(document.createTextNode(str));
    return div.innerHTML;
  }

  /* ========================================
     Review Quantity Controls
     ======================================== */
  function initReviewQuantityControls() {
    reviewItemsContainer.querySelectorAll('.cpb-review__item').forEach((row) => {
      const key = row.dataset.reviewKey;
      const minusBtn = row.querySelector('.cpb-review__qty-minus');
      const plusBtn = row.querySelector('.cpb-review__qty-plus');

      plusBtn.addEventListener('click', () => {
        const entry = selectedProducts.get(key);
        if (!entry) return;
        entry.quantity++;
        selectedProducts.set(key, entry);
        syncReviewToCard(entry);
        saveToStorage();
        updateStepCounts();
        renderReview();
      });

      minusBtn.addEventListener('click', () => {
        const entry = selectedProducts.get(key);
        if (!entry) return;
        entry.quantity--;
        if (entry.quantity <= 0) {
          selectedProducts.delete(key);
          syncReviewToCard({ ...entry, quantity: 0 });
        } else {
          selectedProducts.set(key, entry);
          syncReviewToCard(entry);
        }
        saveToStorage();
        updateStepCounts();
        renderReview();
      });
    });
  }

  /**
   * Sync review panel quantity change back to the product card.
   */
  function syncReviewToCard(entry) {
    const card = section.querySelector(
      `.cpb-product-card[data-product-id="${entry.productId}"]`
    );
    if (!card) return;
    const qtyDisplay = card.querySelector('.cpb-qty-value');
    if (qtyDisplay) {
      qtyDisplay.textContent = entry.quantity;
    }
    const minusBtn = card.querySelector('.cpb-qty-btn--minus');
    if (minusBtn) {
      updateMinusBtnState(minusBtn, entry.quantity);
    }
    if (entry.quantity <= 0) {
      card.classList.remove('cpb-product-card--selected');
    } else {
      card.classList.add('cpb-product-card--selected');
    }
  }

  /* ========================================
     Price Totals
     ======================================== */
  function calculateTotals() {
    let total = 0;
    let compareTotal = 0;

    for (const entry of selectedProducts.values()) {
      total += entry.price * entry.quantity;
      if (entry.comparePrice && entry.comparePrice > entry.price) {
        compareTotal += entry.comparePrice * entry.quantity;
      } else {
        compareTotal += entry.price * entry.quantity;
      }
    }

    finalPriceEl.textContent = moneyFormat(total);
    originalPriceEl.textContent = moneyFormat(compareTotal);

    // Monthly estimate (divide by 12)
    const monthly = total / 12;
    monthlyPriceEl.textContent = moneyFormat(Math.round(monthly));

    // Savings
    const saved = compareTotal - total;
    if (saved > 0) {
      savingsMessageEl.textContent = `Congrats! You're saving ${moneyFormat(saved)} on your security bundle!`;
      savingsMessageEl.style.display = '';
      originalPriceEl.style.display = '';
    } else {
      savingsMessageEl.style.display = 'none';
      originalPriceEl.style.display = 'none';
    }
  }

  /* ========================================
     Checkout — Add to Shopify Cart
     ======================================== */
  function initCheckout() {
    if (!checkoutBtn) return;
    checkoutBtn.addEventListener('click', async () => {
      if (selectedProducts.size === 0) return;

      const items = [];
      for (const entry of selectedProducts.values()) {
        items.push({
          id: entry.variantId,
          quantity: entry.quantity,
        });
      }

      checkoutBtn.disabled = true;
      checkoutBtn.textContent = 'Adding to cart…';

      try {
        const res = await fetch('/cart/add.js', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ items }),
        });

        if (res.ok) {
          // Clear localStorage after successful checkout
          clearStorage();
          selectedProducts.clear();
          window.location.href = '/cart';
        } else {
          const data = await res.json();
          alert(data.description || 'Could not add items to cart.');
          checkoutBtn.disabled = false;
          checkoutBtn.textContent = 'Checkout';
        }
      } catch (err) {
        console.error('Checkout error:', err);
        alert('Something went wrong. Please try again.');
        checkoutBtn.disabled = false;
        checkoutBtn.textContent = 'Checkout';
      }
    });
  }

  /* ========================================
     Initialize
     ======================================== */
  function init() {
    initAccordions();
    initNextButtons();
    initSwatches();
    initQuantityControls();
    initCheckout();

    // Load persisted selections from localStorage and restore UI
    loadFromStorage();
    if (selectedProducts.size > 0) {
      restoreUIFromState();
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();

/* Subtle fade-up on scroll; inert under prefers-reduced-motion. */
(function () {
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  if (typeof IntersectionObserver === 'undefined') return;
  var els = document.querySelectorAll('.card, .panel, .stat, .rec-tile, .mem-tile, .proof-tile, .kit-cta, .ddl-panel, .pub-cta, .talk-row, .dl-tile, .press-tile, .featured-list > *');
  var io = new IntersectionObserver(function (entries) {
    entries.forEach(function (e) {
      if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); }
    });
  }, { threshold: 0.08, rootMargin: '0px 0px -4%' });
  els.forEach(function (el) { el.classList.add('reveal'); io.observe(el); });
})();

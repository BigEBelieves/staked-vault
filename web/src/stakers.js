import { ethers } from 'ethers';
import { CONFIG, readProvider as sharedReadProvider } from './config.js';
/* $STAKED Vault - public stakers leaderboard. Reads Staked events + live balances straight from Base (no backend). */
(function () {
  var VAULT = CONFIG.VAULT_ADDRESS;
  var DEPLOY_BLOCK = CONFIG.DEPLOY_BLOCK;
  var CHAIN_ID = 8453;
  var LOG_RPC = "https://base-rpc.publicnode.com";
  var READ_RPC = "https://mainnet.base.org";
  var MAX_ROWS = 500;
  var ABI = [
    "function balanceOf(address) view returns (uint256)",
    "function lockEnd(address) view returns (uint256)",
    "function totalSupply() view returns (uint256)"
  ];

  async function getStakedLogs(ethers, readProvider) {
    var topic = ethers.utils.id("Staked(address,uint256,uint256)");
    try {
      var lp = new ethers.providers.StaticJsonRpcProvider(LOG_RPC, CHAIN_ID);
      return await lp.getLogs({ address: VAULT, topics: [topic], fromBlock: DEPLOY_BLOCK, toBlock: "latest" });
    } catch (e) { /* fall through to chunked scan */ }
    var head = await readProvider.getBlockNumber();
    var ranges = [];
    for (var s = DEPLOY_BLOCK; s <= head; s += 2000) ranges.push([s, Math.min(s + 1999, head)]);
    var out = [];
    for (var i = 0; i < ranges.length; i += 5) {
      var batch = await Promise.all(ranges.slice(i, i + 5).map(function (r) {
        return readProvider.getLogs({ address: VAULT, topics: [topic], fromBlock: r[0], toBlock: r[1] });
      }));
      batch.forEach(function (b) { out = out.concat(b); });
    }
    return out;
  }

  async function fetchStakers(ethers) {
    var rp = sharedReadProvider;
    var vault = new ethers.Contract(VAULT, ABI, rp);
    var logs = await getStakedLogs(ethers, rp);
    var seen = {};
    logs.forEach(function (l) { seen[ethers.utils.getAddress("0x" + l.topics[1].slice(26))] = true; });
    var addrs = Object.keys(seen);
    var total = await vault.totalSupply();
    var rows = await Promise.all(addrs.map(async function (a) {
      var r = await Promise.all([vault.balanceOf(a), vault.lockEnd(a)]);
      return { address: a, balance: r[0], lockEnd: r[1].toNumber() };
    }));
    rows = rows.filter(function (r) { return r.balance.gt(0); });
    rows.sort(function (a, b) { return a.balance.gt(b.balance) ? -1 : a.balance.lt(b.balance) ? 1 : 0; });
    return { rows: rows.slice(0, MAX_ROWS), total: total, count: rows.length };
  }



  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }
  function fmt(bn) { return parseFloat(ethers.utils.formatUnits(bn, 18)).toLocaleString(undefined, { maximumFractionDigits: 2 }); }
  function short(a) { return a.slice(0, 6) + "..." + a.slice(-4); }
  function lockText(t) {
    var left = t - Math.floor(Date.now() / 1000);
    if (left <= 0) return '<span style="color:var(--secondary)">Unlocked</span>';
    var d = Math.floor(left / 86400), h = Math.floor((left % 86400) / 3600), m = Math.floor((left % 3600) / 60);
    return '<span style="color:var(--warning)">' + (d > 0 ? d + "d " : "") + h + "h " + m + "m left</span>";
  }

  var css = document.createElement("style");
  css.textContent =
    ".stk-wrap{margin:2rem 0}" +
    ".stk-head{display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:.75rem;margin-bottom:1rem}" +
    ".stk-head h3{font-size:1.25rem;font-weight:700}" +
    ".stk-meta{color:var(--text-muted);font-size:.85rem}" +
    ".stk-search{background:var(--bg);border:1px solid var(--card-border);color:var(--text);border-radius:10px;padding:.55rem .8rem;font-size:.85rem;min-width:220px}" +
    ".stk-table{width:100%;border-collapse:collapse;font-size:.9rem}" +
    ".stk-table th{text-align:left;color:var(--text-dim);font-weight:600;font-size:.72rem;letter-spacing:.06em;text-transform:uppercase;padding:.6rem .5rem;border-bottom:1px solid var(--card-border)}" +
    ".stk-table td{padding:.7rem .5rem;border-bottom:1px solid var(--card-border);font-family:ui-monospace,Menlo,monospace}" +
    ".stk-table tr:last-child td{border-bottom:none}" +
    ".stk-table a{color:var(--primary);text-decoration:none}" +
    ".stk-table a:hover{text-decoration:underline}" +
    ".stk-num{text-align:right}" +
    ".stk-bar{height:4px;border-radius:2px;background:var(--card-border);margin-top:5px;overflow:hidden}" +
    ".stk-bar>i{display:block;height:100%;background:var(--primary)}" +
    ".stk-you td{background:var(--primary-glow)}" +
    ".stk-empty{color:var(--text-muted);text-align:center;padding:1.5rem 0;font-size:.9rem}" +
    ".stk-scroll{overflow-x:auto}";
  document.head.appendChild(css);

  var wrap = document.createElement("div");
  wrap.className = "card stk-wrap";
  wrap.innerHTML =
    '<div class="stk-head"><div><h3>Stakers</h3><div class="stk-meta" id="stkMeta">Loading from Base...</div></div>' +
    '<input class="stk-search" id="stkSearch" placeholder="Search wallet address" autocomplete="off"></div>' +
    '<div class="stk-scroll"><table class="stk-table"><thead><tr><th>#</th><th>Wallet</th><th class="stk-num">Staked (STAKED)</th><th class="stk-num">Share</th><th>Lock</th></tr></thead>' +
    '<tbody id="stkBody"><tr><td colspan="5" class="stk-empty">Loading stakers...</td></tr></tbody></table></div>';
  var anchor = document.querySelector(".protocol-flywheel");
  if (anchor && anchor.parentNode) anchor.parentNode.insertBefore(wrap, anchor);
  else document.body.appendChild(wrap);

  var state = { data: null };
  function render() {
    var body = document.getElementById("stkBody");
    if (!state.data) return;
    var q = (document.getElementById("stkSearch").value || "").trim().toLowerCase();
    var me = (window.userAddress || (typeof userAddress !== "undefined" ? userAddress : "") || "").toLowerCase();
    var d = state.data, total = d.total;
    document.getElementById("stkMeta").textContent = d.count + " staker" + (d.count === 1 ? "" : "s") + " | " + fmt(total) + " STAKED staked in total";
    var rows = d.rows.map(function (r, i) { r.rank = i + 1; return r; }).filter(function (r) { return !q || r.address.toLowerCase().indexOf(q) !== -1; });
    if (!rows.length) { body.innerHTML = '<tr><td colspan="5" class="stk-empty">' + (d.count ? "No wallet matches your search." : "No stakers yet. Be the first.") + "</td></tr>"; return; }
    body.innerHTML = rows.map(function (r) {
      var pct = total.gt(0) ? r.balance.mul(10000).div(total).toNumber() / 100 : 0;
      var isMe = me && r.address.toLowerCase() === me;
      return '<tr class="' + (isMe ? "stk-you" : "") + '"><td>' + r.rank + '</td>' +
        '<td><a href="https://basescan.org/address/' + esc(r.address) + '" target="_blank" rel="noopener" title="' + esc(r.address) + '">' + esc(short(r.address)) + "</a>" + (isMe ? " (you)" : "") + "</td>" +
        '<td class="stk-num">' + fmt(r.balance) + "</td>" +
        '<td class="stk-num">' + pct.toFixed(2) + '%<div class="stk-bar"><i style="width:' + Math.min(100, pct) + '%"></i></div></td>' +
        "<td>" + lockText(r.lockEnd) + "</td></tr>";
    }).join("");
  }

  async function load() {
    try { state.data = await fetchStakers(ethers); render(); }
    catch (e) {
      console.warn("stakers", e);
      if (!state.data) document.getElementById("stkBody").innerHTML = '<tr><td colspan="5" class="stk-empty">Could not load stakers right now. Retrying...</td></tr>';
    }
  }
  document.getElementById("stkSearch").addEventListener("input", render);
  load();
  setInterval(load, 60000);
  setInterval(render, 30000);
})();

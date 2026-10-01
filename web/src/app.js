import {connectionGate, closePairing} from './wallet-session.js';
import { ethers } from 'ethers';
import QRCode from 'qrcode';
import {pendingRequest, sendTracked, recoverPending} from './pending.js';
import { CONFIG, readProvider } from './config.js';
import { parseAmount, checkWallet, friendlyError, walletDeepLink } from './safety.js';
    // ==========================================
    // CONFIGURATION CONSTANTS
    // ==========================================
    const WC_PROJECT_ID = "8970cd9ed5eb0de88206ad00f50b813b";

    // Minimal ABIs
    const ERC20_ABI = [
      "function balanceOf(address account) view returns (uint256)",
      "function allowance(address owner, address spender) view returns (uint256)",
      "function approve(address spender, uint256 amount) returns (bool)",
      "function decimals() view returns (uint8)"
    ];

    const VAULT_ABI = [
      "function balanceOf(address) view returns (uint256)",
      "function totalSupply() view returns (uint256)",
      "function lockEnd(address) view returns (uint256)",
      "function earned(address token, address account) view returns (uint256)",
      "function previewWithdraw(address account, uint256 amount) view returns (uint256 returned, uint256 penalty, uint256 usdcForfeited, uint256 bnkrForfeited)",
      "function rewardRatePerSecond(address token) view returns (uint256)",
      "function buybackReserve() view returns (uint256)",
      "function totalPenaltyBurned() view returns (uint256)",
      "function totalBuybackBurned() view returns (uint256)",
      "function stake(uint256 amount) external",
      "function withdraw(uint256 amount) external",
      "function earlyWithdraw(uint256 amount) external",
      "function getReward() external",
      "function exit() external"
    ];

    // Read-only provider so visitors see protocol stats before connecting a wallet


    // State Variables
    let provider = null;
    let signer = null;
    let userAddress = null;
    let stakedTokenContract = null;
    let vaultContract = null;

    let userWalletBalance = ethers.BigNumber.from(0);
    let userStakedBalance = ethers.BigNumber.from(0);
    let userLockExpiry = 0;
    let currentAllowance = ethers.BigNumber.from(0);
    let userEarnedUSDC = ethers.BigNumber.from(0);
    let userEarnedBNKR = ethers.BigNumber.from(0);

    let accountDataLoaded = false;
    let refreshingAccount = false;
    let activeTab = "stake";
    let countdownInterval = null;

    const connection = connectionGate();

    // Toast helper
    function showToast(msg, icon = "ℹ️") {
      const toast = document.getElementById("toast");
      document.getElementById("toastMsg").innerText = msg;
      document.getElementById("toastIcon").innerText = icon;
      toast.classList.add("show");
      setTimeout(() => toast.classList.remove("show"), 4000);
    }

    // Wallet Modal Helpers
    function showWalletModal() {
      document.getElementById("walletModal").classList.add("active");
    }

    function hideWalletModal(cancel = true) {
      if (cancel) cancelConnection();
      document.getElementById("walletModal").classList.remove("active");
      showWcView("main");
    }

    // Switch between modal views: main | picker | qr
    function showWcView(view) {
      document.getElementById("wcMain").style.display = view === "main" ? "flex" : "none";
      document.getElementById("wcPicker").style.display = view === "picker" ? "block" : "none";
      document.getElementById("wcQrPanel").style.display = view === "qr" ? "block" : "none";
      document.getElementById("injectedPicker").style.display = view === "injected" ? "block" : "none";
      const titles = { injected: "Choose a browser wallet", main: "Connect Wallet", picker: "Choose a Wallet", qr: "Connect Wallet" };
      document.getElementById("walletModalTitle").innerText = titles[view] || "Connect Wallet";
    }

    // Connect Entrypoint
    function connectWallet() {
      if (userAddress) {
        if (confirm("Disconnect wallet?")) {
          window.location.reload();
        }
        return;
      }
      showWcView("main");
      showWalletModal();
    }

    // ==========================================
    // Searchable wallet list (WalletConnect registry)
    // ==========================================
    const IS_MOBILE = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
    let wcDefaultWallets = null;   // first page of wallets that support Base
    let wcSearchTimer = null;
    let wcSearchSeq = 0;
    let wcCurrentUri = "";
    let wcAttempt = null;
    function cancelConnection() {
      const attempt = connection.cancel();
      wcCurrentUri = "";
      document.getElementById('wcQrImg').removeAttribute('src');
      document.getElementById('wcOpenBtn').removeAttribute('href');
      if (attempt && attempt === wcAttempt) cleanupWc(attempt);
    }
    async function cleanupWc(attempt) {
      // Serialize cleanup but allow another pass if a URI/session arrives late.
      attempt.cleanup = (attempt.cleanup || Promise.resolve()).then(() => closePairing(attempt.wc, attempt.topic));
      try { await attempt.cleanup; }
      catch { showToast('Connection cleanup could not finish. Reload before reconnecting.', '⚠️'); }
    }
    const installedWallets = new Map();
    window.addEventListener('eip6963:announceProvider', event => {
      const d = event.detail;
      if (!d?.provider || typeof d.provider.request !== 'function' || typeof d.info?.name !== 'string') return;
      installedWallets.set(d.provider, {provider:d.provider, name:d.info.name.slice(0,80)});
      if (document.getElementById('injectedPicker').style.display === 'block') renderInjectedWallets();
    });
    window.dispatchEvent(new Event('eip6963:requestProvider'));
    function browserWallets() {
      if (installedWallets.size) return [...installedWallets.values()];
      const providers = window.ethereum?.providers || (window.ethereum ? [window.ethereum] : []);
      return [...new Set(providers)].filter(p => typeof p?.request === 'function').map(p => ({provider:p,
        name:p.isRabby ? 'Rabby' : p.isCoinbaseWallet ? 'Coinbase Wallet' : p.isMetaMask ? 'MetaMask' : 'Browser wallet'}));
    }
    function renderInjectedWallets() {
      const list = document.getElementById('injectedList'); list.replaceChildren();
      const wallets = browserWallets();
      if (!wallets.length) { list.textContent = 'No browser wallet detected. Use the mobile WalletConnect option, or unlock your extension and try again.'; return; }
      for (const wallet of wallets) {
        const button = document.createElement('button'); button.className = 'wc-item';
        button.textContent = wallet.name; button.onclick = () => connectInjected(wallet.provider);
        list.appendChild(button);
      }
    }
    function openInjectedPicker() {
      window.dispatchEvent(new Event('eip6963:requestProvider'));
      showWcView('injected'); renderInjectedWallets();
    }

    async function fetchWcWallets(query) {
      const url = "https://explorer-api.walletconnect.com/v3/wallets?projectId=" + WC_PROJECT_ID +
        "&entries=100&page=1&chains=eip155:8453" + (query ? "&search=" + encodeURIComponent(query) : "");
      const r = await fetch(url);
      if (!r.ok) throw new Error("wallet list " + r.status);
      const j = await r.json();
      return Object.values(j.listings || {});
    }

    function renderWcList(wallets, query) {
      const list = document.getElementById("wcList");
      list.innerHTML = "";

      // Always-available option: generic QR (any WalletConnect wallet)
      const qrBtn = document.createElement("button");
      qrBtn.className = "wc-item";
      qrBtn.innerHTML = '<div class="wallet-opt-icon opt-icon-wc" style="width:34px;height:34px;font-size:1rem;">QR</div>' +
        '<div><div class="wc-item-name">Show QR code</div><div class="wc-item-sub">Works with any WalletConnect wallet</div></div>';
      qrBtn.onclick = function () { connectWalletConnect(null); };
      list.appendChild(qrBtn);

      if (!wallets.length) {
        const empty = document.createElement("div");
        empty.className = "wc-empty";
        empty.textContent = query ? 'No wallets found for "' + query + '"' : "No wallets found";
        list.appendChild(empty);
        return;
      }

      wallets.forEach(function (w) {
        const btn = document.createElement("button");
        btn.className = "wc-item";
        const img = document.createElement("img");
        img.alt = "";
        img.loading = "lazy";
        img.src = (w.image_url && (w.image_url.sm || w.image_url.md)) || "";
        img.onerror = function () { img.style.visibility = "hidden"; };
        const meta = document.createElement("div");
        const nm = document.createElement("div");
        nm.className = "wc-item-name";
        nm.textContent = w.name;
        const sub = document.createElement("div");
        sub.className = "wc-item-sub";
        sub.textContent = w.category || "Wallet";
        meta.appendChild(nm);
        meta.appendChild(sub);
        btn.appendChild(img);
        btn.appendChild(meta);
        btn.onclick = function () { connectWalletConnect(w); };
        list.appendChild(btn);
      });
    }

    async function openWcPicker() {
      showWcView("picker");
      const input = document.getElementById("wcSearch");
      input.value = "";
      setTimeout(function () { input.focus(); }, 50);
      if (wcDefaultWallets) {
        renderWcList(wcDefaultWallets, "");
        return;
      }
      document.getElementById("wcList").innerHTML = '<div class="wc-empty">Loading wallets...</div>';
      try {
        wcDefaultWallets = await fetchWcWallets("");
        if (!document.getElementById("wcSearch").value) renderWcList(wcDefaultWallets, "");
      } catch (e) {
        console.error("wallet list failed", e);
        renderWcList([], "");
        showToast("Could not load wallet list. You can still use the QR code.", "⚠️");
      }
    }

    function onWcSearch() {
      const q = document.getElementById("wcSearch").value.trim();
      clearTimeout(wcSearchTimer);
      if (!q) {
        if (wcDefaultWallets) renderWcList(wcDefaultWallets, "");
        return;
      }
      // instant local filter on the loaded page, then refine from the full registry
      if (wcDefaultWallets) {
        const ql = q.toLowerCase();
        renderWcList(wcDefaultWallets.filter(function (w) { return (w.name || "").toLowerCase().indexOf(ql) !== -1; }), q);
      }
      const seq = ++wcSearchSeq;
      wcSearchTimer = setTimeout(async function () {
        try {
          const res = await fetchWcWallets(q);
          if (seq !== wcSearchSeq) return;
          if (document.getElementById("wcSearch").value.trim() !== q) return;
          renderWcList(res, q);
        } catch (e) { console.warn("wallet search failed", e); }
      }, 300);
    }

    function wcDeepLink(wallet, uri) { return walletDeepLink(wallet, uri); }

    async function handleWcUri(uri, wallet, attempt) {
      if (attempt.cancelled) return;
      wcCurrentUri = uri;
      const qrTitle = document.getElementById("wcQrTitle");
      const note = document.getElementById("wcQrNote");
      const img = document.getElementById("wcQrImg");
      const openBtn = document.getElementById("wcOpenBtn");
      const copyBtn = document.getElementById("wcCopyBtn");
      const link = wcDeepLink(wallet, uri);

      qrTitle.innerText = wallet ? "Connect " + wallet.name : "Scan with your wallet";
      copyBtn.style.display = "inline-flex";

      if (link) {
        openBtn.href = link;
        openBtn.innerText = "Open " + wallet.name;
        openBtn.style.display = "inline-flex";
      } else {
        openBtn.style.display = "none";
      }

      if (IS_MOBILE && link) {
        note.innerText = "Opening " + wallet.name + "... approve the connection in the app, then come back to this page.";
        img.style.display = "none";
        window.location.href = link;
        return;
      }

      note.innerText = wallet
        ? "Scan this QR code with " + wallet.name + " on your phone, or use the button below on mobile."
        : "Scan this QR code with any WalletConnect-compatible wallet.";
      try {
        const src = await QRCode.toDataURL(uri, { width: 240, margin: 1 });
        if (attempt.cancelled) return;
        img.src = src;
        img.style.display = "block";
      } catch (e) {
        console.error("QR render failed", e);
        img.style.display = "none";
        note.innerText = "Could not render the QR code. Use Copy connection link and paste it into your wallet.";
      }
    }

    async function copyWcUri() {
      try {
        await navigator.clipboard.writeText(wcCurrentUri);
        showToast("Connection link copied", "✅");
      } catch (e) {
        showToast("Copy failed. Long-press the QR code or try again.", "⚠️");
      }
    }

    function cancelWcConnect() {
      cancelConnection();
      showWcView("picker");
    }

    async function connectInjected(injected) {
      const attempt = connection.begin();
      if (!attempt) { showToast('Finish or cancel the current wallet connection first.'); return; }
      try {
        provider = new ethers.providers.Web3Provider(injected);
        await provider.send("eth_requestAccounts", []);

        if (attempt.cancelled) return;
        const network = await provider.getNetwork();
        if (network.chainId !== CONFIG.CHAIN_ID) {
          try {
            await injected.request({
              method: "wallet_switchEthereumChain",
              params: [{ chainId: CONFIG.CHAIN_HEX }]
            });
          } catch (switchError) {
            if (switchError.code === 4902) {
              await injected.request({
                method: "wallet_addEthereumChain",
                params: [{
                  chainId: CONFIG.CHAIN_HEX,
                  chainName: "Base",
                  nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 },
                  rpcUrls: [CONFIG.RPC_URL],
                  blockExplorerUrls: ["https://basescan.org"]
                }]
              });
            } else {
              showToast("Please switch to Base Mainnet", "⚠️");
              return;
            }
          }
        }

        if (attempt.cancelled) return;
        signer = provider.getSigner();
        const address = await signer.getAddress();
        await checkWallet(provider, address);
        if (attempt.cancelled) return;
        userAddress = address;
        hideWalletModal(false);
        signer = provider.getSigner(userAddress);
        window.userAddress = userAddress;

        document.getElementById("connectBtn").innerText = `${userAddress.slice(0, 6)}...${userAddress.slice(-4)}`;

        initContracts();
        await refreshUserData();
        showToast("Connected to Base", "✅");

        injected.on?.("accountsChanged", () => window.location.reload());
        injected.on?.("chainChanged", () => window.location.reload());

      } catch (err) {
        console.error("Wallet connection error:", err);
        if (!attempt.cancelled) showToast(friendlyError(err, "connect your wallet"), "❌");
      } finally { connection.finish(attempt); }
    }

    // WalletConnect v2 (wallet = registry listing or null for generic QR)
    async function connectWalletConnect(wallet) {
      const attempt = connection.begin();
      if (!attempt) { showToast('A connection is still pending or closing. Please wait.'); return; }
      wcAttempt = attempt;
      showWalletModal();
      showWcView("qr");
      document.getElementById("wcQrTitle").innerText = wallet ? "Connecting to " + wallet.name : "Preparing connection";
      document.getElementById("wcQrNote").innerText = "Loading WalletConnect...";
      document.getElementById("wcQrImg").style.display = "none";
      document.getElementById("wcOpenBtn").style.display = "none";
      document.getElementById("wcCopyBtn").style.display = "none";

      try {
        const { EthereumProvider } = await import('./wallet-connect.js');
        if (attempt.cancelled) return;
        const wc = await EthereumProvider.init({
          projectId: WC_PROJECT_ID,
          optionalChains: [CONFIG.CHAIN_ID],
          showQrModal: false,
          rpcMap: {
            8453: CONFIG.RPC_URL
          },
          metadata: {
            name: "$STAKED Vault",
            description: "Dual Real-Yield Staking on Base",
            url: window.location.origin,
            icons: []
          }
        });
        attempt.wc = wc;
        if (attempt.cancelled) return;
        attempt.onUri = uri => {
          attempt.topic = /^wc:([0-9a-f]+)@/i.exec(uri)?.[1];
          if (attempt.cancelled) { cleanupWc(attempt); return; }
          handleWcUri(uri, wallet, attempt);
        };
        wc.on("display_uri", attempt.onUri);
        await wc.enable();
        if (attempt.cancelled) return;

        provider = new ethers.providers.Web3Provider(wc);
        signer = provider.getSigner();
        const address = await signer.getAddress();
        await checkWallet(provider, address);
        if (attempt.cancelled) return;
        userAddress = address;
        attempt.accepted = true;
        hideWalletModal(false);
        signer = provider.getSigner(userAddress);
        window.userAddress = userAddress;

        document.getElementById("connectBtn").innerText = `${userAddress.slice(0, 6)}...${userAddress.slice(-4)}`;

        initContracts();
        await refreshUserData();
        showToast("Connected via WalletConnect", "⚡");

        wc.on("accountsChanged", () => window.location.reload());
        wc.on("chainChanged", () => window.location.reload());
        wc.on("disconnect", () => window.location.reload());

      } catch (err) {
        console.error("WalletConnect error:", err);
        if (!attempt.cancelled) { hideWalletModal(false); showToast(friendlyError(err, "connect your wallet"), "❌"); }
      } finally {
        if (attempt.onUri) attempt.wc.removeListener('display_uri', attempt.onUri);
        if (!attempt.accepted) await cleanupWc(attempt);
        // Failed cleanup deliberately keeps the slot blocked until reload.
        try { await attempt.cleanup; connection.finish(attempt); } catch {}
        if (wcAttempt === attempt) wcAttempt = null;
      }
    }

    function initContracts() {
      showPending();
      const runner = signer || readProvider;
      stakedTokenContract = new ethers.Contract(CONFIG.STAKED_TOKEN, ERC20_ABI, runner);
      if (CONFIG.VAULT_ADDRESS && ethers.utils.isAddress(CONFIG.VAULT_ADDRESS)) {
        vaultContract = new ethers.Contract(CONFIG.VAULT_ADDRESS, VAULT_ABI, runner);
        document.getElementById("vaultScanLink").href = `https://basescan.org/address/${CONFIG.VAULT_ADDRESS}`;
      }
      if (CONFIG.DISTRIBUTOR_ADDRESS && ethers.utils.isAddress(CONFIG.DISTRIBUTOR_ADDRESS)) {
        document.getElementById("distributorScanLink").href = `https://basescan.org/address/${CONFIG.DISTRIBUTOR_ADDRESS}`;
      }
    }

    // Protocol-wide stats (no wallet needed)
    async function refreshProtocolStats() {
      if (!CONFIG.VAULT_ADDRESS) {
        document.getElementById("totalStakedDisplay").innerText = "Not Deployed";
        return;
      }
      try {
        const ro = new ethers.Contract(CONFIG.VAULT_ADDRESS, VAULT_ABI, readProvider);
        const [total, usdcRate] = await Promise.all([
          ro.totalSupply(),
          ro.rewardRatePerSecond(CONFIG.USDC_TOKEN)
        ]);
        document.getElementById("totalStakedDisplay").innerText = parseFloat(ethers.utils.formatUnits(total, 18)).toLocaleString(undefined, { maximumFractionDigits: 2 });
        // USDC streamed per week = rate(1e18-scaled usdc-wei/sec) * 604800 / 1e18 / 1e6
        const usdcPerWeek = parseFloat(ethers.utils.formatUnits(usdcRate.mul(604800), 24));
        const el = document.getElementById("weeklyUsdcDisplay");
        if (el) el.innerText = "$" + usdcPerWeek.toLocaleString(undefined, { maximumFractionDigits: 2 }) + " / wk";
      } catch (e) { console.warn("protocol stats", e); }
    }

    // Switch Tabs
    function switchTab(tab) {
      activeTab = tab;
      document.getElementById("tabStake").classList.toggle("active", tab === "stake");
      document.getElementById("tabUnstake").classList.toggle("active", tab === "unstake");
      document.getElementById("stakeSection").style.display = tab === "stake" ? "block" : "none";
      document.getElementById("unstakeSection").style.display = tab === "unstake" ? "block" : "none";
      if (tab === "unstake") validateUnstakeInput();
    }

    // Set Max
    function setMaxStake() {
      document.getElementById("stakeInput").value = ethers.utils.formatUnits(userWalletBalance, 18);
      validateStakeInput();
    }

    function setMaxUnstake() {
      document.getElementById("unstakeInput").value = ethers.utils.formatUnits(userStakedBalance, 18);
      validateUnstakeInput();
    }

    // Refresh Data
    async function refreshUserData() {
      if (!userAddress || refreshingAccount) return;
      refreshingAccount = true;
      const readAccount = userAddress;
      const readToken = new ethers.Contract(CONFIG.STAKED_TOKEN, ERC20_ABI, readProvider);
      const readVault = new ethers.Contract(CONFIG.VAULT_ADDRESS, VAULT_ABI, readProvider);
      document.getElementById('accountReadStatus').textContent = 'Refreshing your balances…';

      try {
        // Read STAKED balance
        userWalletBalance = await readToken.balanceOf(readAccount);
        document.getElementById("walletTokenBalance").innerText = parseFloat(ethers.utils.formatUnits(userWalletBalance, 18)).toLocaleString(undefined, { maximumFractionDigits: 2 });

        if (vaultContract) {
          // Read Vault state
          const [total, userStaked, expiry, earnedU, earnedB] = await Promise.all([
            readVault.totalSupply(),
            readVault.balanceOf(readAccount),
            readVault.lockEnd(readAccount),
            readVault.earned(CONFIG.USDC_TOKEN, readAccount),
            readVault.earned(CONFIG.BNKR_TOKEN, readAccount)
          ]);

          userStakedBalance = userStaked;
          userLockExpiry = expiry.toNumber();
          userEarnedUSDC = earnedU;
          userEarnedBNKR = earnedB;

          document.getElementById("totalStakedDisplay").innerText = parseFloat(ethers.utils.formatUnits(total, 18)).toLocaleString(undefined, { maximumFractionDigits: 2 });
          document.getElementById("userStakedDisplay").innerText = parseFloat(ethers.utils.formatUnits(userStaked, 18)).toLocaleString(undefined, { maximumFractionDigits: 2 });
          document.getElementById("userStakedBalSub").innerText = parseFloat(ethers.utils.formatUnits(userStaked, 18)).toLocaleString(undefined, { maximumFractionDigits: 2 });

          // Formatted Rewards (USDC = 6 decimals, BNKR = 18 decimals)
          const usdcNum = parseFloat(ethers.utils.formatUnits(earnedU, 6));
          const bnkrNum = parseFloat(ethers.utils.formatUnits(earnedB, 18));
          document.getElementById("earnedUSDCDisplay").innerText = usdcNum.toFixed(4);
          document.getElementById("earnedUSDCValue").innerText = `≈ $${usdcNum.toFixed(2)}`;
          document.getElementById("earnedBNKRDisplay").innerText = bnkrNum.toFixed(4);

          // Allowance
          currentAllowance = await readToken.allowance(readAccount, CONFIG.VAULT_ADDRESS);

          // Update lock countdown
          startLockCountdown();


        } else {
          document.getElementById("totalStakedDisplay").innerText = "Not Deployed";
          document.getElementById("userStakedDisplay").innerText = "0.00";
        }

        accountDataLoaded = true;
        document.getElementById('accountReadStatus').textContent = 'Balances updated from Base.';
        validateStakeInput();
        validateUnstakeInput();
        updateLockActions();

      } catch (err) {
        accountDataLoaded = false;
        for (const id of ['earnedBNKRDisplay','earnedUSDCDisplay','earnedUSDCValue']) document.getElementById(id).textContent = 'Unavailable';
        document.getElementById('userStakedDisplay').textContent = 'Unavailable';
        document.getElementById('userStakedBalSub').textContent = 'Unavailable';
        document.getElementById('accountReadStatus').textContent = 'Your wallet is connected, but balances could not load. Tap Refresh balances to try again.';
        for (const id of ['stakeActionBtn','unstakeActionBtn','claimRewardsBtn','reduceApprovalBtn']) document.getElementById(id).disabled = true;
        console.warn('Account balance read unavailable', err.code || 'unknown');
      } finally { refreshingAccount = false; }
    }

    function updateLockActions() {
      const unlocked = Date.now()/1000 >= userLockExpiry;
      document.getElementById('claimRewardsBtn').disabled = transactionBusy || !accountDataLoaded || !userAddress || !unlocked || (userEarnedUSDC.isZero() && userEarnedBNKR.isZero());
      document.getElementById('claimConditionText').textContent = unlocked ? 'Claim Available' : 'Locked Until Timer Expires';
      document.getElementById('claimConditionText').style.color = unlocked ? 'var(--secondary)' : 'var(--warning)';
      validateUnstakeInput();
    }

    // Countdown Timer Loop
    function startLockCountdown() {
      if (countdownInterval) clearInterval(countdownInterval);

      const update = () => {
        const now = Math.floor(Date.now() / 1000);
        const remaining = userLockExpiry - now;
        updateLockActions();

        const box = document.getElementById("lockStatusBox");
        const badge = document.getElementById("lockStatusBadge");
        const countdownEl = document.getElementById("lockCountdown");

        if (userStakedBalance.isZero()) {
          countdownEl.innerText = "No Active Stake";
          badge.innerText = "INACTIVE";
          badge.className = "status-pill";
          box.className = "lock-timer-box";
          return;
        }

        if (remaining <= 0) {
          countdownEl.innerText = "00d 00h 00m 00s";
          badge.innerText = "UNLOCKED";
          badge.className = "status-pill pill-unlocked";
          box.className = "lock-timer-box unlocked";
        } else {
          const days = Math.floor(remaining / 86400);
          const hours = Math.floor((remaining % 86400) / 3600);
          const minutes = Math.floor((remaining % 3600) / 60);
          const seconds = remaining % 60;

          countdownEl.innerText = `${String(days).padStart(2, '0')}d ${String(hours).padStart(2, '0')}h ${String(minutes).padStart(2, '0')}m ${String(seconds).padStart(2, '0')}s`;
          badge.innerText = "LOCKED";
          badge.className = "status-pill pill-locked";
          box.className = "lock-timer-box locked";
        }
      };

      update();
      countdownInterval = setInterval(update, 1000);
    }

    // Input Validation
    function validateStakeInput() {
      if (transactionBusy) return;
      if (userAddress && !accountDataLoaded) { document.getElementById("stakeActionBtn").disabled = true; return; }
      document.getElementById("approvalNotice").hidden = true;
      const btn = document.getElementById("stakeActionBtn");
      if (!CONFIG.DEPOSIT_ENABLED) { btn.innerText = "New deposits use V3"; btn.disabled = true; return; }
      btn.hidden = !userAddress;
      if (!userAddress) { btn.disabled = true; btn.onclick = null; return; }

      if (!CONFIG.VAULT_ADDRESS) {
        btn.innerText = "Vault Contract Not Set";
        btn.disabled = true;
        return;
      }

      const val = document.getElementById("stakeInput").value;
      if (!val || isNaN(val) || parseFloat(val) <= 0) {
        btn.innerText = "Enter Amount";
        btn.disabled = true;
        return;
      }

      let amountWei;
      try { amountWei = parseAmount(val); } catch { btn.innerText = "Enter a valid amount"; btn.disabled = true; return; }
      if (amountWei.gt(userWalletBalance)) {
        btn.innerText = "Insufficient $STAKED";
        btn.disabled = true;
        return;
      }

      const notice = document.getElementById('approvalNotice');
      notice.hidden = !currentAllowance.gt(amountWei);
      document.getElementById('reduceApprovalBtn').disabled = transactionBusy;
      if (currentAllowance.lt(amountWei)) {
        btn.innerText = "Approve $STAKED";
        btn.disabled = false;
        btn.onclick = handleApprove;
      } else {
        btn.innerText = "Stake $STAKED";
        btn.disabled = false;
        btn.onclick = handleStake;
      }
    }

    function validateUnstakeInput() {
      if (transactionBusy) return;
      if (userAddress && !accountDataLoaded) { document.getElementById("unstakeActionBtn").disabled = true; return; }
      const btn = document.getElementById("unstakeActionBtn");
      const warningBox = document.getElementById("penaltyWarningBox");

      if (!userAddress || !CONFIG.VAULT_ADDRESS) {
        btn.disabled = true;
        warningBox.style.display = "none";
        return;
      }

      const val = document.getElementById("unstakeInput").value;
      if (!val || isNaN(val) || parseFloat(val) <= 0) {
        btn.innerText = "Enter Amount";
        btn.disabled = true;
        warningBox.style.display = "none";
        return;
      }

      let amountWei;
      try { amountWei = parseAmount(val); } catch { btn.innerText = "Enter a valid amount"; btn.disabled = true; return; }
      if (amountWei.gt(userStakedBalance)) {
        btn.innerText = "Exceeds Staked Balance";
        btn.disabled = true;
        warningBox.style.display = "none";
        return;
      }

      const isLocked = Math.floor(Date.now() / 1000) < userLockExpiry;

      if (isLocked) {
        warningBox.style.display = "block";
        const num = parseFloat(val);
        const penalty = num * 0.20;
        const net = num * 0.80;
        document.getElementById("slashedCalc").innerText = penalty.toLocaleString(undefined, { maximumFractionDigits: 4 });
        document.getElementById("netReturnCalc").innerText = net.toLocaleString(undefined, { maximumFractionDigits: 4 });
        btn.innerText = "Accept 20% Penalty & Unstake";
        btn.disabled = false;
      } else {
        warningBox.style.display = "none";
        btn.innerText = "Unstake $STAKED";
        btn.disabled = false;
      }
    }

    // Explicit user actions only; this module never sends on load.
    let transactionBusy = false;
    function markBusy(value) {
      transactionBusy = value;
      for (const id of ['stakeActionBtn','unstakeActionBtn','claimRewardsBtn','reduceApprovalBtn']) document.getElementById(id).disabled = value;
      document.getElementById('stakeInput').disabled = value;
      document.getElementById('unstakeInput').disabled = value;
      for (const button of document.querySelectorAll('.max-btn')) button.disabled = value;
    }
    async function act(label, operation) {
      if (transactionBusy) return;
      markBusy(true);
      try {
        await checkWallet(provider, userAddress);
        if (!accountDataLoaded) throw new Error('Refresh account balances first');
        if (pendingRequest(userAddress)) throw new Error("Previous request unresolved");
        await operation();
        await refreshUserData();
      } catch (err) {
        console.error('Wallet action failed:', err.code || 'unknown');
        showToast(pendingRequest(userAddress) ? 'A wallet request is unresolved. Check its status below before trying again.' : friendlyError(err, label), '❌');
      } finally {
        markBusy(false);
        showPending();
        validateStakeInput(); validateUnstakeInput();
        document.getElementById('claimRewardsBtn').disabled = !accountDataLoaded || !userAddress || Date.now()/1000 < userLockExpiry || (userEarnedUSDC.isZero() && userEarnedBNKR.isZero());
      }
    }
    async function stakeDetails() {
      if (!CONFIG.DEPOSIT_ENABLED) throw new Error('New deposits use V3');
      const amount = parseAmount(document.getElementById('stakeInput').value);
      const balance = await stakedTokenContract.balanceOf(userAddress);
      if (amount.gt(balance)) throw Object.assign(new Error('Balance too low'), {code:'INSUFFICIENT_BALANCE'});
      return amount;
    }
    async function handleApprove() {
      return act('approve your stake amount', async () => {
        const amount = await stakeDetails();
        await checkWallet(provider, userAddress);
        await stakedTokenContract.callStatic.approve(CONFIG.VAULT_ADDRESS, amount);
        await sendTracked(provider,userAddress,stakedTokenContract,'approve',[CONFIG.VAULT_ADDRESS,amount]);
        showToast('Approval submitted. Waiting for confirmation…', '⏳');
        showToast('Only the entered stake amount is approved.', '✅');
      });
    }
    async function handleStake() {
      return act('stake your tokens', async () => {
        const amount = await stakeDetails();
        const allowance = await stakedTokenContract.allowance(userAddress, CONFIG.VAULT_ADDRESS);
        if (allowance.lt(amount)) throw Object.assign(new Error('Approval needed'), {code:'APPROVAL_REQUIRED'});
        await checkWallet(provider, userAddress);
        if (userStakedBalance.gt(0) && !confirm('Adding to your stake resets the seven-day lock for your ENTIRE position. Continue?')) return;
        await vaultContract.callStatic.stake(amount);
        await sendTracked(provider,userAddress,vaultContract,'stake',[amount]);
        showToast('Stake submitted. Waiting for confirmation…', '⏳');
        document.getElementById('stakeInput').value = '';
        showToast('Your tokens are staked.', '✅');
      });
    }
    async function handleUnstake() {
      return act('withdraw your tokens', async () => {
        const amount = parseAmount(document.getElementById('unstakeInput').value);
        const block = await provider.getBlock('latest');
        const [expiry, balance, preview] = await Promise.all([
          vaultContract.lockEnd(userAddress, {blockTag:block.number}),
          vaultContract.balanceOf(userAddress, {blockTag:block.number}),
          vaultContract.previewWithdraw(userAddress, amount, {blockTag:block.number})
        ]);
        if (amount.gt(balance)) throw Object.assign(new Error('Balance too low'), {code:'INSUFFICIENT_BALANCE'});
        const locked = block.timestamp < expiry.toNumber();
        if (locked && !confirm(
          'EARLY WITHDRAWAL — your seven-day lock is active.\n\n' +
          'You receive ' + ethers.utils.formatUnits(preview.returned,18) + ' STAKED.\n' +
          ethers.utils.formatUnits(preview.penalty,18) + ' STAKED will be burned (20% of this withdrawal).\n' +
          'You forfeit ALL accrued rewards for your entire stake: ' + ethers.utils.formatUnits(preview.usdcForfeited,6) + ' USDC and ' + ethers.utils.formatUnits(preview.bnkrForfeited,18) + ' BNKR.\n' +
          'This includes rewards associated with any tokens you leave staked.\n\nContinue with the early withdrawal?'
        )) return;
        await checkWallet(provider, userAddress);
        const method = locked && CONFIG.VAULT_VERSION === 3 ? 'earlyWithdraw' : 'withdraw';
        await vaultContract.callStatic[method](amount);
        await checkWallet(provider, userAddress);
        await sendTracked(provider,userAddress,vaultContract,method,[amount]);
        showToast('Withdrawal submitted. Waiting for confirmation…', '⏳');
        document.getElementById('unstakeInput').value = '';
        showToast('Withdrawal confirmed.', '✅');
      });
    }
    async function handleClaimRewards() {
      return act('claim your rewards', async () => {
        await vaultContract.callStatic.getReward();
        await sendTracked(provider,userAddress,vaultContract,'getReward');
        showToast('Claim submitted. Waiting for confirmation…', '⏳');
        showToast('Rewards received in your wallet.', '✅');
      });
    }

    // Auto-check provider on load
    window.addEventListener("load", () => {
      if (window.ethereum) provider = new ethers.providers.Web3Provider(window.ethereum);
      initContracts();
      refreshProtocolStats();
      setInterval(refreshProtocolStats, 30000);
    });

// Explicit event bindings: no inline script handlers or eval.
document.querySelector('[data-action="ui-1"]').addEventListener("click", function(event) { connectWallet(); });
document.querySelector('[data-action="ui-2"]').addEventListener("click", function(event) { switchTab('stake'); });
document.querySelector('[data-action="ui-3"]').addEventListener("click", function(event) { switchTab('unstake'); });
document.querySelector('[data-action="ui-4"]').addEventListener("input", function(event) { validateStakeInput(); });
document.querySelector('[data-action="ui-5"]').addEventListener("click", function(event) { setMaxStake(); });
document.querySelector('[data-action="ui-6"]').onclick = handleStake;
document.querySelector('[data-action="ui-7"]').addEventListener("input", function(event) { validateUnstakeInput(); });
document.querySelector('[data-action="ui-8"]').addEventListener("click", function(event) { setMaxUnstake(); });
document.querySelector('[data-action="ui-9"]').addEventListener("click", function(event) { handleUnstake(); });
document.querySelector('[data-action="ui-10"]').addEventListener("click", function(event) { handleClaimRewards(); });
document.querySelector('[data-action="ui-11"]').addEventListener("click", function(event) { if(event.target === this) hideWalletModal(); });
document.querySelector('[data-action="ui-12"]').addEventListener("click", function(event) { hideWalletModal(); });
document.querySelector('[data-action="ui-13"]').addEventListener("click", function(event) { openWcPicker(); });
document.querySelector('[data-action="ui-14"]').addEventListener("click", function(event) { openInjectedPicker(); });
document.querySelector('[data-action="ui-15"]').addEventListener("click", function(event) { showWcView('main'); });
document.querySelector('[data-action="ui-16"]').addEventListener("input", function(event) { onWcSearch(); });
document.querySelector('[data-action="ui-17"]').addEventListener("click", function(event) { cancelWcConnect(); });
document.querySelector('[data-action="ui-18"]').addEventListener("click", function(event) { copyWcUri(); });

document.getElementById("reduceApprovalBtn").addEventListener("click", handleApprove);

function showPending() {
  const saved = pendingRequest(userAddress);
  document.getElementById('pendingNotice').hidden = !saved;
  if (saved) {
    document.getElementById('pendingText').textContent = saved.hash ? 'A transaction was submitted. Check its confirmation before another action.' : 'The wallet request may have been submitted. Check wallet activity; do not repeat it. If you cancelled without a transaction, contact support to resolve this saved request.';
    if (saved.invalid) document.getElementById('pendingText').textContent = 'Saved wallet request data is unreadable. Balances remain available, but new transactions are blocked. Contact support before retrying.';
    document.getElementById('checkPending').disabled = !!saved.invalid;
    document.getElementById('recoveryHash').value = saved.hash || '';
  }
}
document.getElementById('checkPending').addEventListener('click',async()=>{
  try { const matched = await recoverPending(provider,userAddress,document.getElementById('recoveryHash').value); showPending(); await refreshUserData(); showToast(matched ? 'Transaction confirmed. Balances refreshed.' : 'Request resolved by a failed or replaced transaction. Review your balances.'); }
  catch { showToast('Could not verify this request. Check the transaction hash and wallet activity; do not resend.'); }
});
window.addEventListener('storage',showPending);
document.getElementById('injectedBack').addEventListener('click',()=>showWcView('main'));
document.addEventListener('keydown',e=>{if(e.key==='Escape') hideWalletModal();});
document.getElementById('vaultLabel').textContent = CONFIG.VAULT_VERSION === 3 ? 'V3 staking' : 'Existing V2 stakes';
document.getElementById(CONFIG.VAULT_VERSION === 3 ? 'v3Link' : 'legacyLink').setAttribute('aria-current','page');
if (!CONFIG.DEPOSIT_ENABLED) {
  document.getElementById('vaultNotice').textContent = 'Your original stake and accrued rewards remain here. Claim or withdraw when eligible. Moving to V3 is optional and requires a separate deposit with a new seven-day lock.';
  switchTab('unstake'); document.getElementById('stakeInput').disabled = true;
}

document.getElementById('refreshBalances').addEventListener('click', refreshUserData);
document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible' && userAddress && !transactionBusy) refreshUserData();});

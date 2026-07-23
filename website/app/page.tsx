const githubUrl = "https://github.com/tomfordrumm/OpenRoughCut";
const releaseVersion = "0.1.2";
const releaseUrl = `${githubUrl}/releases/tag/v${releaseVersion}`;
const assetUrl = `${githubUrl}/releases/download/v${releaseVersion}`;

const features = [
  {
    number: "01",
    title: "Silence, spotted",
    copy: "Tune the threshold, minimum silence, and pause to keep. OpenRoughCut turns quiet stretches into precise suggestions.",
  },
  {
    number: "02",
    title: "Your media stays yours",
    copy: "Analysis and optional Whisper transcription run on your machine. Your recordings never need to visit a server.",
  },
  {
    number: "03",
    title: "Edits, not a mystery render",
    copy: "Export an editable timeline for Final Cut Pro, Premiere Pro, or DaVinci Resolve—always linked to the original media.",
  },
  {
    number: "04",
    title: "Review every decision",
    copy: "Preview the cut, inspect every removal, restore a pause, or draw a manual edit. Automation suggests; you decide.",
  },
  {
    number: "05",
    title: "Find the better take",
    copy: "Optional local transcription can flag strong false starts and repeated takes while preserving uncertain moments for review.",
  },
  {
    number: "06",
    title: "Built for long recordings",
    copy: "Lightweight proxy playback keeps the interface responsive while every exported cut still references your untouched source.",
  },
];

const downloads = [
  {
    platform: "macOS",
    architecture: "Apple Silicon",
    detail: "M1, M2, M3, M4 and newer",
    size: "115 MB",
    badge: "Recommended",
    icon: "⌘",
    href: `${assetUrl}/OpenRoughCut-${releaseVersion}-mac-arm64.dmg`,
  },
  {
    platform: "macOS",
    architecture: "Intel",
    detail: "64-bit Intel Macs",
    size: "117 MB",
    badge: null,
    icon: "⌘",
    href: `${assetUrl}/OpenRoughCut-${releaseVersion}-mac-x64.dmg`,
  },
  {
    platform: "Windows",
    architecture: "x64",
    detail: "64-bit Windows PCs",
    size: "115 MB",
    badge: null,
    icon: "⊞",
    href: `${assetUrl}/OpenRoughCut-${releaseVersion}-win-x64.exe`,
  },
];

const waveform = [52, 68, 84, 46, 72, 94, 56, 78, 62, 38, 24, 16, 8, 6, 10, 7, 5, 9, 34, 58, 72, 46, 82, 68, 96, 54, 76, 42, 66, 38, 26, 18, 7, 5, 9, 6, 28, 52, 80, 64, 92, 58, 76, 46, 30, 18, 12, 8];

export default function Home() {
  return (
    <main>
      <nav className="nav-shell" aria-label="Main navigation">
        <a className="brand" href="#top" aria-label="OpenRoughCut home">
          <span className="brand-mark">ORC</span>
          <span>OpenRoughCut</span>
        </a>
        <div className="nav-links">
          <a href="#features">Features</a>
          <a href="#download">Download</a>
          <a href="#open-source">Open source</a>
        </div>
        <a className="nav-github" href={githubUrl} target="_blank" rel="noreferrer">
          GitHub <span aria-hidden="true">↗</span>
        </a>
      </nav>

      <section className="hero section-shell" id="top">
        <div className="hero-copy">
          <div className="eyebrow"><span /> Open source video editing utility</div>
          <h1>Cut the silence.<br /><em>Keep the story.</em></h1>
          <p className="hero-lede">
            OpenRoughCut finds the pauses, false starts, and repeated takes in long recordings—then exports a timeline you can still edit.
          </p>
          <div className="hero-actions">
            <a className="button button-primary" href="#download">Download free <span aria-hidden="true">↓</span></a>
            <a className="button button-secondary" href={githubUrl} target="_blank" rel="noreferrer">View source <span aria-hidden="true">↗</span></a>
          </div>
          <div className="hero-proof" aria-label="Product highlights">
            <span>100% local</span>
            <span>Editable exports</span>
            <span>Free to use</span>
          </div>
        </div>

        <div className="hero-visual" aria-label="OpenRoughCut editing interface illustration">
          <div className="orbit orbit-one" />
          <div className="orbit orbit-two" />
          <div className="local-pill"><i /> PRIVATE · ON DEVICE</div>
          <div className="editor-window">
            <div className="editor-titlebar">
              <div className="window-dots"><i /><i /><i /></div>
              <span>interview.mov</span>
              <b>ORC</b>
            </div>
            <div className="editor-preview">
              <div className="preview-frame">
                <span className="subject-shape subject-one" />
                <span className="subject-shape subject-two" />
                <span className="play-mark">▶</span>
              </div>
              <div className="preview-meta">
                <span>SOURCE / 00:18:42</span>
                <strong>Edited preview</strong>
              </div>
            </div>
            <div className="timeline">
              <div className="timeline-ruler"><span>00:00</span><span>04:00</span><span>08:00</span><span>12:00</span></div>
              <div className="waveform" aria-hidden="true">
                {waveform.map((height, index) => <i key={index} style={{ height: `${height}%` }} />)}
              </div>
              <div className="cut cut-one"><span>silence</span></div>
              <div className="cut cut-two"><span>silence</span></div>
              <div className="playhead"><i /></div>
            </div>
            <div className="editor-footer">
              <span><i className="status-dot" /> 14 suggested cuts</span>
              <button type="button">Export timeline <b>↗</b></button>
            </div>
          </div>
          <div className="saved-pill"><strong>08:16</strong><span>silence removed</span></div>
        </div>
      </section>

      <section className="format-strip" aria-label="Supported timeline formats">
        <span>EXPORT TO</span>
        <strong>Final Cut Pro</strong><i>FCPXML</i>
        <strong>Premiere Pro</strong><i>XML</i>
        <strong>DaVinci Resolve</strong><i>OTIO</i>
      </section>

      <section className="features section-shell" id="features">
        <div className="section-intro">
          <div className="eyebrow"><span /> Built for the first cut</div>
          <h2>Less trimming.<br /><em>More deciding.</em></h2>
          <p>OpenRoughCut handles the repetitive search so you can spend your time on rhythm, meaning, and the moments worth keeping.</p>
        </div>
        <div className="feature-grid">
          {features.map((feature) => (
            <article className="feature-card" key={feature.number}>
              <span className="feature-number">{feature.number}</span>
              <div className="feature-rule"><i /></div>
              <h3>{feature.title}</h3>
              <p>{feature.copy}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="download-section" id="download">
        <div className="section-shell">
          <div className="download-heading">
            <div>
              <div className="eyebrow eyebrow-light"><span /> Version {releaseVersion}</div>
              <h2>Your next rough cut<br />starts <em>here.</em></h2>
            </div>
            <p>Choose the build for your computer. Setup downloads the verified editing engine and private speech models on first launch.</p>
          </div>
          <div className="download-grid">
            {downloads.map((download) => (
              <a className="download-card" href={download.href} key={`${download.platform}-${download.architecture}`}>
                <div className="download-card-top">
                  <span className="platform-icon">{download.icon}</span>
                  {download.badge && <span className="download-badge">{download.badge}</span>}
                  <span className="download-arrow">↓</span>
                </div>
                <span className="platform-name">{download.platform}</span>
                <h3>{download.architecture}</h3>
                <p>{download.detail}</p>
                <div className="download-meta"><span>v{releaseVersion}</span><span>{download.size}</span><span>Installer</span></div>
              </a>
            ))}
          </div>
          <div className="download-footnote">
            <p><strong>Heads up:</strong> This early friends release is not code-signed yet. Your operating system may ask you to approve opening it.</p>
            <div>
              <a href={`${assetUrl}/SHA256SUMS.txt`}>Checksums ↗</a>
              <a href={releaseUrl}>All release files ↗</a>
            </div>
          </div>
        </div>
      </section>

      <section className="open-source section-shell" id="open-source">
        <div className="source-art" aria-hidden="true">
          <span className="source-bracket">{`{`}</span>
          <div><strong>ORC</strong><i>OPEN / LOCAL / EDITABLE</i></div>
          <span className="source-bracket">{`}`}</span>
        </div>
        <div className="source-copy">
          <div className="eyebrow"><span /> Built in public</div>
          <h2>Open code.<br /><em>Open decisions.</em></h2>
          <p>OpenRoughCut is developed in public. Inspect how a cut is made, follow every change, and help shape a more transparent editing tool.</p>
          <div className="source-links">
            <a className="button button-ink" href={githubUrl} target="_blank" rel="noreferrer">Explore the repository <span>↗</span></a>
            <a href={releaseUrl}>Read the release notes</a>
          </div>
        </div>
      </section>

      <section className="community section-shell">
        <article className="community-card bug-card">
          <span className="community-kicker">FOUND SOMETHING ODD?</span>
          <h2>Good bugs deserve<br />a clear timeline.</h2>
          <p>Tell us what happened, what you expected, and how to reproduce it. Add your operating system and OpenRoughCut version—but never upload private recordings.</p>
          <a className="text-link" href={`${githubUrl}/issues/new`} target="_blank" rel="noreferrer">Report a bug on GitHub <span>↗</span></a>
          <div className="bug-stamp">ISSUE<br />TRACKER</div>
        </article>
        <article className="community-card contribute-card">
          <span className="community-kicker">MAKE THE NEXT CUT</span>
          <h2>Contributions<br />are welcome.</h2>
          <p>Fix an issue, improve an export, sharpen the interface, or propose a new workflow. Start with the code and open a focused pull request.</p>
          <a className="text-link" href={`${githubUrl}#readme`} target="_blank" rel="noreferrer">See how it works <span>↗</span></a>
          <div className="contribute-lines" aria-hidden="true"><i /><i /><i /></div>
        </article>
      </section>

      <section className="closing-cta section-shell">
        <div>
          <span>READY WHEN YOU ARE</span>
          <h2>Find the quiet.<br /><em>Keep what matters.</em></h2>
        </div>
        <a className="button button-primary button-large" href="#download">Download OpenRoughCut <span>↓</span></a>
      </section>

      <footer>
        <div className="footer-brand"><span className="brand-mark">ORC</span><strong>OpenRoughCut</strong></div>
        <p>Local-first tools for a more editable first cut.</p>
        <div className="footer-links">
          <a href={githubUrl}>GitHub</a>
          <a href={`${githubUrl}/issues`}>Issues</a>
          <a href={releaseUrl}>Releases</a>
        </div>
        <span className="footer-note">OPEN SOURCE · 2026</span>
      </footer>
    </main>
  );
}

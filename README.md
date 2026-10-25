# Vaseball ⚾

ブラウザで遊べる野球ゲーム。現在は CPU (Bot) とのオフライン対戦に対応しています。
今後、別ホストのサーバーを介したリアルタイムオンライン対戦に対応する予定です。

## 遊び方

| 場面 | 操作 |
| --- | --- |
| 打つ | 黄色い円 (ミート位置) をマウス / 矢印キー / WASD で動かし、ボールが手元に来た瞬間にクリック / Space。スマホはボールの来る位置をタップ |
| 投げる | 1〜6 キー (または画面下のボタン) で球種を選び、狙うコースにカーソルを合わせてクリック / Space |

- 打撃はタイミング (±100ms) とミート位置のズレで打球の質が決まります。早いと引っ張り、遅いと流し打ち。ボールの上を叩くとゴロ、下を叩くとフライになります。
- 投球の狙いには球種ごとのブレがあります。ボールの軌道は終盤に変化します。

## 開発

```sh
npm install
npm run dev        # http://localhost:5173
npm test           # core のテスト (ルール + Bot 同士の 200 試合シミュレーション)
npm run typecheck
npm run build      # packages/client/dist に出力
```

`main` に push すると GitHub Actions (`.github/workflows/deploy.yml`) が GitHub Pages にデプロイします。
リポジトリの Settings → Pages → Source を「GitHub Actions」にしてください。

## 構成

```
packages/
  core/     DOM 非依存・決定的なゲームロジック (クライアントと将来のサーバーで共有)
    pitch.ts     球種・投球生成・軌道
    batting.ts   スイング判定 → 打球 (初速・角度・方向)
    fielding.ts  打球処理 (フライ捕球・ゴロ・併殺・内野安打・本塁打) とアニメーション用の軌跡
    rules.ts     カウント・進塁・得点・チェンジ・サヨナラ・延長
    bot.ts       CPU の投球 / 打撃判断
    rng.ts       シード付き乱数
  client/   Vite + Canvas の Web クライアント
    game/        試合進行 (session) / 入力 / コントローラ (Human・Bot)
    render/      捕手視点の投球画面・俯瞰フィールド・HUD
```

### オンライン化の方針

1 球のやり取りは「投手の入力 (`PitchInput`)」と「打者の入力 (`SwingInput`)」の 2 つだけです。

1. 投手クライアント → サーバー: `PitchInput` (球種・狙い)
2. サーバー: `createPitch` で実際の投球を確定し、リリース時刻とともに両者へ送信
3. 打者クライアント: 受け取った投球をローカルで再生し、**リリースからの経過時間** で `SwingInput` を送信 (通信遅延がタイミングに影響しない)
4. サーバー: `resolvePitchEvent` → `applyPitchEvent` で結果を確定し、両者へ配信

乱数はサーバーが持ち、`core` をそのまま使って権威的に判定します。クライアント側は
`PitcherController` / `BatterController` に Remote 実装を追加するだけで同じ試合進行を使えます。

import type { TeamInfo } from './rules';

const SURNAMES = [
  '佐藤', '鈴木', '高橋', '田中', '伊藤', '渡辺', '山本', '中村', '小林',
  '加藤', '吉田', '山田', '佐々木', '山口', '松本', '井上', '木村', '林',
];

export function makeTeam(name: string, short: string, nameOffset = 0): TeamInfo {
  const lineup = Array.from({ length: 9 }, (_, i) => SURNAMES[(i + nameOffset) % SURNAMES.length]!);
  return { name, short, lineup };
}

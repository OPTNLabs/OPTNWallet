import {
  createAddonModuleLocaleBundles,
  type AddonModuleLocaleMessages,
} from '../../../i18n/addonModuleLocale';
import type { AddonLocale } from '../../../types/addons';
import { ADDON_COMMON_MESSAGES } from '../locales/common';

export const PARYON_MODULE_ID = 'paryon' as const;

const messages: AddonModuleLocaleMessages = {
  en: {
    'module.protocolSnapshot': 'Protocol snapshot',
    'module.liveThreads': 'Live contract threads',
    'module.balances': 'Balances',
    'module.primaryActions': 'Primary actions',
    'module.borrow': 'Borrow',
    'module.stake': 'Stake',
    'module.redeem': 'Redeem',
    'module.positions': 'Positions',
    'module.safetyRails': 'Safety rails',
    'module.protocolDetails': 'Protocol details',
    'module.deployment': 'Deployment',
    'module.readiness': 'Readiness',
    'module.liveBundle': 'Live bundle',
    'module.loan': 'Loan',
    'module.stabilityPool': 'Stability pool',
    'module.redemption': 'Redemption',
    'module.selectedPosition': 'Selected position',
    'module.walletHistory': 'Wallet history',
    'module.nativeForm': 'Native form',
  },
  es: {
    'module.protocolSnapshot': 'Resumen del protocolo',
    'module.liveThreads': 'Hilos de contratos activos',
    'module.balances': 'Saldos',
    'module.primaryActions': 'Acciones principales',
    'module.borrow': 'Pedir prestado',
    'module.stake': 'Depositar',
    'module.redeem': 'Canjear',
    'module.positions': 'Posiciones',
    'module.safetyRails': 'Controles de seguridad',
    'module.protocolDetails': 'Detalles del protocolo',
    'module.deployment': 'Despliegue',
    'module.readiness': 'Preparación',
    'module.liveBundle': 'Paquete activo',
    'module.loan': 'Préstamo',
    'module.stabilityPool': 'Pool de estabilidad',
    'module.redemption': 'Canje',
    'module.selectedPosition': 'Posición seleccionada',
    'module.walletHistory': 'Historial de la cartera',
    'module.nativeForm': 'Formulario nativo',
  },
  'pt-BR': {
    'module.protocolSnapshot': 'Visão do protocolo',
    'module.liveThreads': 'Fluxos de contratos ativos',
    'module.balances': 'Saldos',
    'module.primaryActions': 'Ações principais',
    'module.borrow': 'Tomar emprestado',
    'module.stake': 'Fazer stake',
    'module.redeem': 'Resgatar',
    'module.positions': 'Posições',
    'module.safetyRails': 'Proteções',
    'module.protocolDetails': 'Detalhes do protocolo',
    'module.deployment': 'Implantação',
    'module.readiness': 'Prontidão',
    'module.liveBundle': 'Pacote ativo',
    'module.loan': 'Empréstimo',
    'module.stabilityPool': 'Pool de estabilidade',
    'module.redemption': 'Resgate',
    'module.selectedPosition': 'Posição selecionada',
    'module.walletHistory': 'Histórico da carteira',
    'module.nativeForm': 'Formulário nativo',
  },
  'zh-CN': {
    'module.protocolSnapshot': '协议快照',
    'module.liveThreads': '实时合约线程',
    'module.balances': '余额',
    'module.primaryActions': '主要操作',
    'module.borrow': '借款',
    'module.stake': '质押',
    'module.redeem': '赎回',
    'module.positions': '仓位',
    'module.safetyRails': '安全措施',
    'module.protocolDetails': '协议详情',
    'module.deployment': '部署',
    'module.readiness': '就绪状态',
    'module.liveBundle': '实时包',
    'module.loan': '贷款',
    'module.stabilityPool': '稳定池',
    'module.redemption': '兑换',
    'module.selectedPosition': '已选仓位',
    'module.walletHistory': '钱包历史',
    'module.nativeForm': '原生表单',
  },
  'zh-TW': {
    'module.protocolSnapshot': '協定快照',
    'module.liveThreads': '即時合約執行緒',
    'module.balances': '餘額',
    'module.primaryActions': '主要操作',
    'module.borrow': '借款',
    'module.stake': '質押',
    'module.redeem': '贖回',
    'module.positions': '部位',
    'module.safetyRails': '安全措施',
    'module.protocolDetails': '協定詳細資料',
    'module.deployment': '部署',
    'module.readiness': '就緒狀態',
    'module.liveBundle': '即時套件',
    'module.loan': '貸款',
    'module.stabilityPool': '穩定池',
    'module.redemption': '兌換',
    'module.selectedPosition': '已選部位',
    'module.walletHistory': '錢包歷史',
    'module.nativeForm': '原生表單',
  },
  vi: {
    'module.protocolSnapshot': 'Tổng quan giao thức',
    'module.liveThreads': 'Luồng hợp đồng trực tiếp',
    'module.balances': 'Số dư',
    'module.primaryActions': 'Thao tác chính',
    'module.borrow': 'Vay',
    'module.stake': 'Stake',
    'module.redeem': 'Đổi',
    'module.positions': 'Vị thế',
    'module.safetyRails': 'Biện pháp an toàn',
    'module.protocolDetails': 'Chi tiết giao thức',
    'module.deployment': 'Triển khai',
    'module.readiness': 'Mức sẵn sàng',
    'module.liveBundle': 'Gói trực tiếp',
    'module.loan': 'Khoản vay',
    'module.stabilityPool': 'Pool ổn định',
    'module.redemption': 'Đổi tài sản',
    'module.selectedPosition': 'Vị thế đã chọn',
    'module.walletHistory': 'Lịch sử ví',
    'module.nativeForm': 'Biểu mẫu gốc',
  },
  ar: {
    'module.protocolSnapshot': 'ملخص البروتوكول',
    'module.liveThreads': 'مسارات العقود المباشرة',
    'module.balances': 'الأرصدة',
    'module.primaryActions': 'الإجراءات الأساسية',
    'module.borrow': 'اقتراض',
    'module.stake': 'تخزين',
    'module.redeem': 'استرداد',
    'module.positions': 'المراكز',
    'module.safetyRails': 'ضوابط الأمان',
    'module.protocolDetails': 'تفاصيل البروتوكول',
    'module.deployment': 'النشر',
    'module.readiness': 'الجاهزية',
    'module.liveBundle': 'الحزمة المباشرة',
    'module.loan': 'القرض',
    'module.stabilityPool': 'مجمع الاستقرار',
    'module.redemption': 'الاسترداد',
    'module.selectedPosition': 'المركز المحدد',
    'module.walletHistory': 'سجل المحفظة',
    'module.nativeForm': 'النموذج الأصلي',
  },
  fr: {
    'module.protocolSnapshot': 'Aperçu du protocole',
    'module.liveThreads': 'Flux de contrats en direct',
    'module.balances': 'Soldes',
    'module.primaryActions': 'Actions principales',
    'module.borrow': 'Emprunter',
    'module.stake': 'Staker',
    'module.redeem': 'Racheter',
    'module.positions': 'Positions',
    'module.safetyRails': 'Garde-fous',
    'module.protocolDetails': 'Détails du protocole',
    'module.deployment': 'Déploiement',
    'module.readiness': 'Disponibilité',
    'module.liveBundle': 'Package actif',
    'module.loan': 'Prêt',
    'module.stabilityPool': 'Pool de stabilité',
    'module.redemption': 'Rachat',
    'module.selectedPosition': 'Position sélectionnée',
    'module.walletHistory': 'Historique du portefeuille',
    'module.nativeForm': 'Formulaire natif',
  },
  ko: {
    'module.protocolSnapshot': '프로토콜 요약',
    'module.liveThreads': '실시간 계약 흐름',
    'module.balances': '잔액',
    'module.primaryActions': '주요 작업',
    'module.borrow': '대출',
    'module.stake': '스테이킹',
    'module.redeem': '상환',
    'module.positions': '포지션',
    'module.safetyRails': '안전장치',
    'module.protocolDetails': '프로토콜 세부 정보',
    'module.deployment': '배포',
    'module.readiness': '준비 상태',
    'module.liveBundle': '실시간 번들',
    'module.loan': '대출',
    'module.stabilityPool': '안정성 풀',
    'module.redemption': '상환',
    'module.selectedPosition': '선택한 포지션',
    'module.walletHistory': '지갑 기록',
    'module.nativeForm': '네이티브 양식',
  },
  ja: {
    'module.protocolSnapshot': 'プロトコル概要',
    'module.liveThreads': 'ライブコントラクトの処理',
    'module.balances': '残高',
    'module.primaryActions': '主な操作',
    'module.borrow': '借りる',
    'module.stake': 'ステーク',
    'module.redeem': '償還',
    'module.positions': 'ポジション',
    'module.safetyRails': '安全策',
    'module.protocolDetails': 'プロトコルの詳細',
    'module.deployment': 'デプロイ',
    'module.readiness': '準備状況',
    'module.liveBundle': 'ライブバンドル',
    'module.loan': 'ローン',
    'module.stabilityPool': '安定性プール',
    'module.redemption': '償還',
    'module.selectedPosition': '選択したポジション',
    'module.walletHistory': 'ウォレット履歴',
    'module.nativeForm': 'ネイティブフォーム',
  },
  ru: {
    'module.protocolSnapshot': 'Сводка протокола',
    'module.liveThreads': 'Активные потоки контрактов',
    'module.balances': 'Балансы',
    'module.primaryActions': 'Основные действия',
    'module.borrow': 'Занять',
    'module.stake': 'Стейкинг',
    'module.redeem': 'Погасить',
    'module.positions': 'Позиции',
    'module.safetyRails': 'Меры безопасности',
    'module.protocolDetails': 'Сведения о протоколе',
    'module.deployment': 'Развёртывание',
    'module.readiness': 'Готовность',
    'module.liveBundle': 'Активный пакет',
    'module.loan': 'Займ',
    'module.stabilityPool': 'Пул стабильности',
    'module.redemption': 'Погашение',
    'module.selectedPosition': 'Выбранная позиция',
    'module.walletHistory': 'История кошелька',
    'module.nativeForm': 'Нативная форма',
  },
  'ha-NG': {
    'module.protocolSnapshot': 'Takaitaccen yarjejeniya',
    'module.liveThreads': 'Zaren kwangila kai tsaye',
    'module.balances': 'Ma’auni',
    'module.primaryActions': 'Manyan ayyuka',
    'module.borrow': 'Aro',
    'module.stake': 'Stake',
    'module.redeem': 'Karɓa',
    'module.positions': 'Matsayi',
    'module.safetyRails': 'Matakan tsaro',
    'module.protocolDetails': 'Bayanan yarjejeniya',
    'module.deployment': 'Sanyawa',
    'module.readiness': 'Shirye-shirye',
    'module.liveBundle': 'Kunshin kai tsaye',
    'module.loan': 'Bashi',
    'module.stabilityPool': 'Wurin kwanciyar hankali',
    'module.redemption': 'Mayarwa',
    'module.selectedPosition': 'Matsayin da aka zaɓa',
    'module.walletHistory': 'Tarihin walat',
    'module.nativeForm': 'Tsarin asali',
  },
};

const supplementalMessages: AddonModuleLocaleMessages = {
  en: {
    'module.loanSubtitle':
      'Open or manage a live loan inside OPTN Wallet with the verified mainnet rules.',
    'module.stabilitySubtitle':
      'Stake into the stability pool to earn liquidations and claims from the live epoch schedule.',
    'module.redemptionSubtitle':
      'Redeem PUSD for BCH at the locked oracle rate, with the native timelock and fee rules enforced in the preview.',
    'module.positionsSubtitle':
      'Wallet-linked loan, pool, and redemption state derived from native UTXO index.',
  },
  es: {
    'module.loanSubtitle':
      'Abre o gestiona un préstamo activo dentro de OPTN Wallet con las reglas verificadas de mainnet.',
    'module.stabilitySubtitle':
      'Deposita en el pool de estabilidad para obtener liquidaciones y reclamaciones del calendario de épocas activo.',
    'module.redemptionSubtitle':
      'Canjea PUSD por BCH al tipo del oráculo bloqueado, con bloqueo temporal y comisiones nativas aplicados en la vista previa.',
    'module.positionsSubtitle':
      'Estado de préstamos, pool y canjes vinculados a la cartera, derivado del índice UTXO nativo.',
  },
  'pt-BR': {
    'module.loanSubtitle':
      'Abra ou gerencie um empréstimo ativo dentro da OPTN Wallet com as regras verificadas da mainnet.',
    'module.stabilitySubtitle':
      'Faça stake no pool de estabilidade para receber liquidações e reivindicações do calendário de épocas ativo.',
    'module.redemptionSubtitle':
      'Resgate PUSD por BCH à taxa do oráculo bloqueada, com timelock e taxas nativas aplicados na prévia.',
    'module.positionsSubtitle':
      'Estado de empréstimos, pools e resgates vinculados à carteira, derivado do índice UTXO nativo.',
  },
  'zh-CN': {
    'module.loanSubtitle':
      '根据已验证的主网规则，在 OPTN Wallet 中开启或管理实时贷款。',
    'module.stabilitySubtitle':
      '存入稳定池，根据实时周期计划获得清算收益和领取权。',
    'module.redemptionSubtitle':
      '按锁定的预言机汇率将 PUSD 兑换为 BCH，预览中会执行原生时间锁和费用规则。',
    'module.positionsSubtitle':
      '由原生 UTXO 索引得出的钱包关联贷款、池和兑换状态。',
  },
  'zh-TW': {
    'module.loanSubtitle':
      '依據已驗證的主網規則，在 OPTN Wallet 中開啟或管理即時貸款。',
    'module.stabilitySubtitle':
      '存入穩定池，依據即時週期計畫取得清算收益與領取權。',
    'module.redemptionSubtitle':
      '依鎖定的預言機匯率將 PUSD 兌換為 BCH，預覽中會套用原生時間鎖與費用規則。',
    'module.positionsSubtitle':
      '由原生 UTXO 索引取得的錢包關聯貸款、池與兌換狀態。',
  },
  vi: {
    'module.loanSubtitle':
      'Mở hoặc quản lý khoản vay trực tiếp trong OPTN Wallet theo các quy tắc mainnet đã xác minh.',
    'module.stabilitySubtitle':
      'Stake vào pool ổn định để nhận thanh lý và quyền nhận theo lịch epoch trực tiếp.',
    'module.redemptionSubtitle':
      'Đổi PUSD lấy BCH theo tỷ giá oracle bị khóa, với timelock và phí gốc được áp dụng trong bản xem trước.',
    'module.positionsSubtitle':
      'Trạng thái khoản vay, pool và đổi tài sản liên kết với ví từ chỉ mục UTXO gốc.',
  },
  ar: {
    'module.loanSubtitle':
      'افتح قرضًا مباشرًا أو أدِره داخل OPTN Wallet وفق قواعد الشبكة الرئيسية الموثقة.',
    'module.stabilitySubtitle':
      'شارك في مجمع الاستقرار لكسب التصفية والمطالبات وفق جدول العصور المباشر.',
    'module.redemptionSubtitle':
      'استرد PUSD مقابل BCH بسعر أوراكل مقفل، مع تطبيق قواعد المهلة الزمنية والرسوم الأصلية في المعاينة.',
    'module.positionsSubtitle':
      'حالة القروض والمجمع والاسترداد المرتبطة بالمحفظة والمستمدة من فهرس UTXO الأصلي.',
  },
  fr: {
    'module.loanSubtitle':
      'Ouvrez ou gérez un prêt actif dans OPTN Wallet selon les règles mainnet vérifiées.',
    'module.stabilitySubtitle':
      'Stakez dans le pool de stabilité pour gagner des liquidations et des droits selon le calendrier d’époques actif.',
    'module.redemptionSubtitle':
      'Rachetez des PUSD contre des BCH au taux d’oracle verrouillé, avec verrouillage temporel et frais natifs appliqués dans l’aperçu.',
    'module.positionsSubtitle':
      'État des prêts, pools et rachats liés au portefeuille, dérivé de l’index UTXO natif.',
  },
  ko: {
    'module.loanSubtitle':
      '검증된 메인넷 규칙에 따라 OPTN Wallet에서 대출을 열거나 관리합니다.',
    'module.stabilitySubtitle':
      '안정성 풀에 스테이킹하여 실시간 에포크 일정에 따른 청산 및 청구 권리를 얻습니다.',
    'module.redemptionSubtitle':
      '잠긴 오라클 가격으로 PUSD를 BCH로 상환하며, 미리보기에서 네이티브 타임락과 수수료 규칙을 적용합니다.',
    'module.positionsSubtitle':
      '네이티브 UTXO 인덱스에서 가져온 지갑 연결 대출, 풀 및 상환 상태입니다.',
  },
  ja: {
    'module.loanSubtitle':
      '検証済みのメインネットルールに従い、OPTN Wallet内でローンを開始または管理します。',
    'module.stabilitySubtitle':
      '安定性プールにステークし、ライブのエポックスケジュールに基づく清算と請求権を得ます。',
    'module.redemptionSubtitle':
      '固定されたオラクルレートでPUSDをBCHに償還します。プレビューではネイティブのタイムロックと手数料ルールが適用されます。',
    'module.positionsSubtitle':
      'ネイティブUTXOインデックスから取得したウォレット連携ローン、プール、償還の状態です。',
  },
  ru: {
    'module.loanSubtitle':
      'Открывайте и управляйте займом в OPTN Wallet по проверенным правилам основной сети.',
    'module.stabilitySubtitle':
      'Вносите средства в пул стабильности и получайте ликвидации и права требования по текущему расписанию эпох.',
    'module.redemptionSubtitle':
      'Обменивайте PUSD на BCH по фиксированному курсу оракула; в предпросмотре применяются нативные правила таймлока и комиссии.',
    'module.positionsSubtitle':
      'Состояние займов, пулов и погашений, связанных с кошельком и полученных из нативного индекса UTXO.',
  },
  'ha-NG': {
    'module.loanSubtitle':
      'Buɗe ko sarrafa rance mai aiki a cikin OPTN Wallet bisa dokokin mainnet da aka tabbatar.',
    'module.stabilitySubtitle':
      'Yi stake a wurin kwanciyar hankali don samun liquidation da haƙƙin karɓa bisa jadawalin epoch.',
    'module.redemptionSubtitle':
      'Mayar da PUSD zuwa BCH bisa ƙimar oracle da aka kulle, tare da dokokin timelock da kuɗi a cikin dubawa.',
    'module.positionsSubtitle':
      'Matsayin rance, wuri da mayarwa da suka shafi walat, daga asalin fihirisar UTXO.',
  },
};

const completeMessages = Object.fromEntries(
  Object.entries(messages).map(([locale, localeMessages]) => [
    locale,
    {
      ...localeMessages,
      ...supplementalMessages[locale as AddonLocale],
    },
  ])
) as AddonModuleLocaleMessages;

export const PARYON_LOCALE_BUNDLES = createAddonModuleLocaleBundles(
  completeMessages,
  ADDON_COMMON_MESSAGES
);

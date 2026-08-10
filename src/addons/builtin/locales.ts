import type { AddonLocale, AddonLocaleBundle } from '../../types/addons';

function createBundles(
  messagesByLocale: Record<AddonLocale, Record<string, string>>
): AddonLocaleBundle[] {
  return Object.entries(messagesByLocale).map(([locale, messages]) => ({
    locale: locale as AddonLocale,
    messages,
  }));
}

// Built-in add-ons are wallet-owned, so their metadata is reviewed alongside
// the core catalog. The app and contract names remain stable product names;
// descriptions and surrounding UI text are localized.
export const BUILTIN_ADDON_LOCALE_BUNDLES: Record<string, AddonLocaleBundle[]> =
  {
    'optn.builtin.demo': createBundles({
      en: {
        'manifest.name': 'OPTN Builtin Demo',
        'manifest.description':
          'Built-in examples for validating the add-on contract.',
        'app.authguard.name': 'AuthGuard',
        'app.authguard.description': 'Token-gated access control.',
        'app.cauldronSwapApp.name': 'Cauldron',
        'app.cauldronSwapApp.description':
          'Swap through Cauldron pools and manage your liquidity positions.',
        'app.paryonWorkspaceApp.name': 'ParyonUSD',
        'app.paryonWorkspaceApp.description':
          'Stablecoin dashboard with live network verification and contract status.',
        'screen.back': 'Back',
        'screen.walletError': 'Wallet error',
        'screen.unavailable': 'Unavailable',
        'screen.noWalletAddress': 'No wallet address is available yet.',
        'contract.paryon-contract-bundle.name': 'ParyonUSD Contract Bundle',
        'contract.paryon-contract-bundle.description':
          'Compiled CashScript artifacts for the ParyonUSD stablecoin system.',
      },
      es: {
        'manifest.name': 'OPTN Builtin Demo',
        'manifest.description':
          'Ejemplos integrados para validar el contrato de complementos.',
        'app.authguard.name': 'AuthGuard',
        'app.authguard.description': 'Control de acceso protegido por tokens.',
        'app.cauldronSwapApp.name': 'Cauldron',
        'app.cauldronSwapApp.description':
          'Intercambia en los pools de Cauldron y gestiona tus posiciones de liquidez.',
        'app.paryonWorkspaceApp.name': 'ParyonUSD',
        'app.paryonWorkspaceApp.description':
          'Panel de la stablecoin con verificación de red en vivo y estado del contrato.',
        'screen.back': 'Volver',
        'screen.walletError': 'Error de la cartera',
        'screen.unavailable': 'No disponible',
        'screen.noWalletAddress':
          'Aún no hay una dirección de cartera disponible.',
        'contract.paryon-contract-bundle.name': 'ParyonUSD Contract Bundle',
        'contract.paryon-contract-bundle.description':
          'Artefactos de CashScript compilados para el sistema de stablecoin ParyonUSD.',
      },
      'pt-BR': {
        'manifest.name': 'OPTN Builtin Demo',
        'manifest.description':
          'Exemplos integrados para validar o contrato de complementos.',
        'app.authguard.name': 'AuthGuard',
        'app.authguard.description': 'Controle de acesso protegido por tokens.',
        'app.cauldronSwapApp.name': 'Cauldron',
        'app.cauldronSwapApp.description':
          'Troque nos pools do Cauldron e gerencie suas posições de liquidez.',
        'app.paryonWorkspaceApp.name': 'ParyonUSD',
        'app.paryonWorkspaceApp.description':
          'Painel da stablecoin com verificação da rede em tempo real e status do contrato.',
        'screen.back': 'Voltar',
        'screen.walletError': 'Erro da carteira',
        'screen.unavailable': 'Indisponível',
        'screen.noWalletAddress':
          'Ainda não há um endereço de carteira disponível.',
        'contract.paryon-contract-bundle.name': 'ParyonUSD Contract Bundle',
        'contract.paryon-contract-bundle.description':
          'Artefatos CashScript compilados para o sistema de stablecoin ParyonUSD.',
      },
      'zh-CN': {
        'manifest.name': 'OPTN Builtin Demo',
        'manifest.description': '用于验证插件契约的内置示例。',
        'app.authguard.name': 'AuthGuard',
        'app.authguard.description': '基于代币的访问控制。',
        'app.cauldronSwapApp.name': 'Cauldron',
        'app.cauldronSwapApp.description':
          '在 Cauldron 流动性池中兑换并管理你的流动性头寸。',
        'app.paryonWorkspaceApp.name': 'ParyonUSD',
        'app.paryonWorkspaceApp.description':
          '提供实时网络验证和合约状态的稳定币面板。',
        'screen.back': '返回',
        'screen.walletError': '钱包错误',
        'screen.unavailable': '不可用',
        'screen.noWalletAddress': '目前没有可用的钱包地址。',
        'contract.paryon-contract-bundle.name': 'ParyonUSD Contract Bundle',
        'contract.paryon-contract-bundle.description':
          'ParyonUSD 稳定币系统的已编译 CashScript 工件。',
      },
      'zh-TW': {
        'manifest.name': 'OPTN Builtin Demo',
        'manifest.description': '用於驗證附加元件契約的內建範例。',
        'app.authguard.name': 'AuthGuard',
        'app.authguard.description': '以代幣控管存取權限。',
        'app.cauldronSwapApp.name': 'Cauldron',
        'app.cauldronSwapApp.description':
          '在 Cauldron 流動性池中兌換並管理你的流動性部位。',
        'app.paryonWorkspaceApp.name': 'ParyonUSD',
        'app.paryonWorkspaceApp.description':
          '提供即時網路驗證與合約狀態的穩定幣面板。',
        'screen.back': '返回',
        'screen.walletError': '錢包錯誤',
        'screen.unavailable': '無法使用',
        'screen.noWalletAddress': '目前沒有可用的錢包地址。',
        'contract.paryon-contract-bundle.name': 'ParyonUSD Contract Bundle',
        'contract.paryon-contract-bundle.description':
          'ParyonUSD 穩定幣系統的已編譯 CashScript 工件。',
      },
      vi: {
        'manifest.name': 'OPTN Builtin Demo',
        'manifest.description':
          'Các ví dụ tích hợp để kiểm tra hợp đồng tiện ích.',
        'app.authguard.name': 'AuthGuard',
        'app.authguard.description': 'Kiểm soát quyền truy cập bằng token.',
        'app.cauldronSwapApp.name': 'Cauldron',
        'app.cauldronSwapApp.description':
          'Hoán đổi qua các pool Cauldron và quản lý vị thế thanh khoản của bạn.',
        'app.paryonWorkspaceApp.name': 'ParyonUSD',
        'app.paryonWorkspaceApp.description':
          'Bảng điều khiển stablecoin với xác minh mạng trực tiếp và trạng thái hợp đồng.',
        'screen.back': 'Quay lại',
        'screen.walletError': 'Lỗi ví',
        'screen.unavailable': 'Không khả dụng',
        'screen.noWalletAddress': 'Chưa có địa chỉ ví nào khả dụng.',
        'contract.paryon-contract-bundle.name': 'ParyonUSD Contract Bundle',
        'contract.paryon-contract-bundle.description':
          'Các artifact CashScript đã biên dịch cho hệ thống stablecoin ParyonUSD.',
      },
      ar: {
        'manifest.name': 'OPTN Builtin Demo',
        'manifest.description': 'أمثلة مضمّنة للتحقق من عقد الإضافات.',
        'app.authguard.name': 'AuthGuard',
        'app.authguard.description': 'التحكم في الوصول المحمي بالرموز.',
        'app.cauldronSwapApp.name': 'Cauldron',
        'app.cauldronSwapApp.description':
          'بدّل عبر مجمعات Cauldron وأدر مراكز السيولة الخاصة بك.',
        'app.paryonWorkspaceApp.name': 'ParyonUSD',
        'app.paryonWorkspaceApp.description':
          'لوحة عملة مستقرة مع التحقق المباشر من الشبكة وحالة العقد.',
        'screen.back': 'رجوع',
        'screen.walletError': 'خطأ في المحفظة',
        'screen.unavailable': 'غير متاح',
        'screen.noWalletAddress': 'لا يوجد عنوان محفظة متاح حتى الآن.',
        'contract.paryon-contract-bundle.name': 'ParyonUSD Contract Bundle',
        'contract.paryon-contract-bundle.description':
          'مصنوعات CashScript المجمّعة لنظام العملة المستقرة ParyonUSD.',
      },
      fr: {
        'manifest.name': 'OPTN Builtin Demo',
        'manifest.description':
          'Exemples intégrés pour valider le contrat des modules complémentaires.',
        'app.authguard.name': 'AuthGuard',
        'app.authguard.description': 'Contrôle d’accès protégé par jeton.',
        'app.cauldronSwapApp.name': 'Cauldron',
        'app.cauldronSwapApp.description':
          'Échangez via les pools Cauldron et gérez vos positions de liquidité.',
        'app.paryonWorkspaceApp.name': 'ParyonUSD',
        'app.paryonWorkspaceApp.description':
          'Tableau de bord du stablecoin avec vérification réseau en direct et état du contrat.',
        'screen.back': 'Retour',
        'screen.walletError': 'Erreur du portefeuille',
        'screen.unavailable': 'Indisponible',
        'screen.noWalletAddress':
          'Aucune adresse de portefeuille n’est encore disponible.',
        'contract.paryon-contract-bundle.name': 'ParyonUSD Contract Bundle',
        'contract.paryon-contract-bundle.description':
          'Artefacts CashScript compilés pour le système stablecoin ParyonUSD.',
      },
      ko: {
        'manifest.name': 'OPTN Builtin Demo',
        'manifest.description':
          '애드온 계약을 검증하기 위한 기본 제공 예제입니다.',
        'app.authguard.name': 'AuthGuard',
        'app.authguard.description': '토큰으로 보호되는 접근 제어입니다.',
        'app.cauldronSwapApp.name': 'Cauldron',
        'app.cauldronSwapApp.description':
          'Cauldron 풀에서 교환하고 유동성 포지션을 관리합니다.',
        'app.paryonWorkspaceApp.name': 'ParyonUSD',
        'app.paryonWorkspaceApp.description':
          '실시간 네트워크 검증과 계약 상태를 제공하는 스테이블코인 대시보드입니다.',
        'screen.back': '뒤로',
        'screen.walletError': '지갑 오류',
        'screen.unavailable': '사용할 수 없음',
        'screen.noWalletAddress': '아직 사용할 수 있는 지갑 주소가 없습니다.',
        'contract.paryon-contract-bundle.name': 'ParyonUSD Contract Bundle',
        'contract.paryon-contract-bundle.description':
          'ParyonUSD 스테이블코인 시스템을 위해 컴파일된 CashScript 아티팩트입니다.',
      },
      ja: {
        'manifest.name': 'OPTN Builtin Demo',
        'manifest.description':
          'アドオンコントラクトを検証する組み込みサンプルです。',
        'app.authguard.name': 'AuthGuard',
        'app.authguard.description': 'トークンで保護されたアクセス制御です。',
        'app.cauldronSwapApp.name': 'Cauldron',
        'app.cauldronSwapApp.description':
          'Cauldronプールで交換し、流動性ポジションを管理します。',
        'app.paryonWorkspaceApp.name': 'ParyonUSD',
        'app.paryonWorkspaceApp.description':
          'ネットワークのライブ検証とコントラクト状態を確認できるステーブルコインダッシュボードです。',
        'screen.back': '戻る',
        'screen.walletError': 'ウォレットエラー',
        'screen.unavailable': '利用できません',
        'screen.noWalletAddress':
          '利用できるウォレットアドレスがまだありません。',
        'contract.paryon-contract-bundle.name': 'ParyonUSD Contract Bundle',
        'contract.paryon-contract-bundle.description':
          'ParyonUSDステーブルコインシステム用にコンパイルされたCashScriptアーティファクトです。',
      },
      ru: {
        'manifest.name': 'OPTN Builtin Demo',
        'manifest.description':
          'Встроенные примеры для проверки контракта дополнений.',
        'app.authguard.name': 'AuthGuard',
        'app.authguard.description': 'Контроль доступа с защитой токеном.',
        'app.cauldronSwapApp.name': 'Cauldron',
        'app.cauldronSwapApp.description':
          'Обменивайте активы в пулах Cauldron и управляйте позициями ликвидности.',
        'app.paryonWorkspaceApp.name': 'ParyonUSD',
        'app.paryonWorkspaceApp.description':
          'Панель стейблкоина с проверкой сети в реальном времени и статусом контракта.',
        'screen.back': 'Назад',
        'screen.walletError': 'Ошибка кошелька',
        'screen.unavailable': 'Недоступно',
        'screen.noWalletAddress': 'Адрес кошелька пока недоступен.',
        'contract.paryon-contract-bundle.name': 'ParyonUSD Contract Bundle',
        'contract.paryon-contract-bundle.description':
          'Скомпилированные артефакты CashScript для системы стейблкоина ParyonUSD.',
      },
      'ha-NG': {
        'manifest.name': 'OPTN Builtin Demo',
        'manifest.description':
          'Misalan da aka gina don tabbatar da kwangilar ƙari.',
        'app.authguard.name': 'AuthGuard',
        'app.authguard.description': 'Sarrafa damar shiga da token.',
        'app.cauldronSwapApp.name': 'Cauldron',
        'app.cauldronSwapApp.description':
          'Yi musayar kuɗi a wuraren Cauldron kuma sarrafa matsayin liquidity ɗinka.',
        'app.paryonWorkspaceApp.name': 'ParyonUSD',
        'app.paryonWorkspaceApp.description':
          'Allon stablecoin mai tabbatar da hanyar sadarwa kai tsaye da matsayin kwangila.',
        'screen.back': 'Koma baya',
        'screen.walletError': 'Kuskuren walat',
        'screen.unavailable': 'Ba ya samuwa',
        'screen.noWalletAddress':
          'Har yanzu babu adireshin walat da yake samuwa.',
        'contract.paryon-contract-bundle.name': 'ParyonUSD Contract Bundle',
        'contract.paryon-contract-bundle.description':
          'Abubuwan CashScript da aka tattara don tsarin stablecoin na ParyonUSD.',
      },
    }),
    'optn.builtin.events': createBundles({
      en: {
        'manifest.name': 'Airdrops',
        'manifest.description':
          'Built-in BCH and CashToken workspace for batch distribution.',
        'app.airdropsApp.name': 'Airdrops',
        'app.airdropsApp.description':
          'Distribute BCH and CashTokens in batches.',
        'screen.back': 'Back',
        'screen.walletError': 'Wallet error',
        'screen.unavailable': 'Unavailable',
        'screen.noWalletAddress': 'No wallet address is available yet.',
      },
      es: {
        'manifest.name': 'Airdrops',
        'manifest.description':
          'Espacio integrado para distribuir BCH y CashTokens por lotes.',
        'app.airdropsApp.name': 'Airdrops',
        'app.airdropsApp.description': 'Distribuye BCH y CashTokens por lotes.',
        'screen.back': 'Volver',
        'screen.walletError': 'Error de la cartera',
        'screen.unavailable': 'No disponible',
        'screen.noWalletAddress':
          'Aún no hay una dirección de cartera disponible.',
      },
      'pt-BR': {
        'manifest.name': 'Airdrops',
        'manifest.description':
          'Espaço integrado para distribuição em lote de BCH e CashTokens.',
        'app.airdropsApp.name': 'Airdrops',
        'app.airdropsApp.description': 'Distribua BCH e CashTokens em lote.',
        'screen.back': 'Voltar',
        'screen.walletError': 'Erro da carteira',
        'screen.unavailable': 'Indisponível',
        'screen.noWalletAddress':
          'Ainda não há um endereço de carteira disponível.',
      },
      'zh-CN': {
        'manifest.name': 'Airdrops',
        'manifest.description': '用于批量分发 BCH 和 CashTokens 的内置工作区。',
        'app.airdropsApp.name': 'Airdrops',
        'app.airdropsApp.description': '批量分发 BCH 和 CashTokens。',
        'screen.back': '返回',
        'screen.walletError': '钱包错误',
        'screen.unavailable': '不可用',
        'screen.noWalletAddress': '目前没有可用的钱包地址。',
      },
      'zh-TW': {
        'manifest.name': 'Airdrops',
        'manifest.description': '用於批次分發 BCH 與 CashTokens 的內建工作區。',
        'app.airdropsApp.name': 'Airdrops',
        'app.airdropsApp.description': '批次分發 BCH 與 CashTokens。',
        'screen.back': '返回',
        'screen.walletError': '錢包錯誤',
        'screen.unavailable': '無法使用',
        'screen.noWalletAddress': '目前沒有可用的錢包地址。',
      },
      vi: {
        'manifest.name': 'Airdrops',
        'manifest.description':
          'Không gian tích hợp để phân phối BCH và CashTokens theo lô.',
        'app.airdropsApp.name': 'Airdrops',
        'app.airdropsApp.description': 'Phân phối BCH và CashTokens theo lô.',
        'screen.back': 'Quay lại',
        'screen.walletError': 'Lỗi ví',
        'screen.unavailable': 'Không khả dụng',
        'screen.noWalletAddress': 'Chưa có địa chỉ ví nào khả dụng.',
      },
      ar: {
        'manifest.name': 'Airdrops',
        'manifest.description':
          'مساحة مضمّنة لتوزيع BCH وCashTokens على دفعات.',
        'app.airdropsApp.name': 'Airdrops',
        'app.airdropsApp.description': 'وزّع BCH وCashTokens على دفعات.',
        'screen.back': 'رجوع',
        'screen.walletError': 'خطأ في المحفظة',
        'screen.unavailable': 'غير متاح',
        'screen.noWalletAddress': 'لا يوجد عنوان محفظة متاح حتى الآن.',
      },
      fr: {
        'manifest.name': 'Airdrops',
        'manifest.description':
          'Espace intégré pour distribuer des BCH et des CashTokens par lots.',
        'app.airdropsApp.name': 'Airdrops',
        'app.airdropsApp.description':
          'Distribuez des BCH et des CashTokens par lots.',
        'screen.back': 'Retour',
        'screen.walletError': 'Erreur du portefeuille',
        'screen.unavailable': 'Indisponible',
        'screen.noWalletAddress':
          'Aucune adresse de portefeuille n’est encore disponible.',
      },
      ko: {
        'manifest.name': 'Airdrops',
        'manifest.description':
          'BCH와 CashTokens를 일괄 배포하는 기본 제공 작업 공간입니다.',
        'app.airdropsApp.name': 'Airdrops',
        'app.airdropsApp.description': 'BCH와 CashTokens를 일괄 배포합니다.',
        'screen.back': '뒤로',
        'screen.walletError': '지갑 오류',
        'screen.unavailable': '사용할 수 없음',
        'screen.noWalletAddress': '아직 사용할 수 있는 지갑 주소가 없습니다.',
      },
      ja: {
        'manifest.name': 'Airdrops',
        'manifest.description':
          'BCHとCashTokensを一括配布する組み込みワークスペースです。',
        'app.airdropsApp.name': 'Airdrops',
        'app.airdropsApp.description': 'BCHとCashTokensを一括配布します。',
        'screen.back': '戻る',
        'screen.walletError': 'ウォレットエラー',
        'screen.unavailable': '利用できません',
        'screen.noWalletAddress':
          '利用できるウォレットアドレスがまだありません。',
      },
      ru: {
        'manifest.name': 'Airdrops',
        'manifest.description':
          'Встроенное рабочее пространство для пакетной раздачи BCH и CashTokens.',
        'app.airdropsApp.name': 'Airdrops',
        'app.airdropsApp.description': 'Пакетная раздача BCH и CashTokens.',
        'screen.back': 'Назад',
        'screen.walletError': 'Ошибка кошелька',
        'screen.unavailable': 'Недоступно',
        'screen.noWalletAddress': 'Адрес кошелька пока недоступен.',
      },
      'ha-NG': {
        'manifest.name': 'Airdrops',
        'manifest.description':
          'Wurin aiki da aka gina don rarraba BCH da CashTokens a rukuni.',
        'app.airdropsApp.name': 'Airdrops',
        'app.airdropsApp.description': 'Rarraba BCH da CashTokens a rukuni.',
        'screen.back': 'Koma baya',
        'screen.walletError': 'Kuskuren walat',
        'screen.unavailable': 'Ba ya samuwa',
        'screen.noWalletAddress':
          'Har yanzu babu adireshin walat da yake samuwa.',
      },
    }),
    'optn.builtin.fundme': createBundles({
      en: {
        'manifest.name': 'FundMe',
        'manifest.description': 'Built-in BCH crowdfunding showcase.',
        'app.fundmeApp.name': 'FundMe',
        'app.fundmeApp.description': 'BCH crowdfunding inside OPTN Wallet.',
        'screen.back': 'Back',
        'screen.demo': 'Demo',
        'screen.discoverCampaigns': 'Discover Campaigns',
        'screen.createCampaign': 'Create Campaign',
        'screen.unavailable': 'Unavailable',
      },
      es: {
        'manifest.name': 'FundMe',
        'manifest.description':
          'Demostración integrada de financiación colectiva con BCH.',
        'app.fundmeApp.name': 'FundMe',
        'app.fundmeApp.description':
          'Financiación colectiva con BCH en OPTN Wallet.',
        'screen.back': 'Volver',
        'screen.demo': 'Demostración',
        'screen.discoverCampaigns': 'Descubrir campañas',
        'screen.createCampaign': 'Crear campaña',
        'screen.unavailable': 'No disponible',
      },
      'pt-BR': {
        'manifest.name': 'FundMe',
        'manifest.description':
          'Demonstração integrada de financiamento coletivo com BCH.',
        'app.fundmeApp.name': 'FundMe',
        'app.fundmeApp.description':
          'Financiamento coletivo com BCH dentro da OPTN Wallet.',
        'screen.back': 'Voltar',
        'screen.demo': 'Demonstração',
        'screen.discoverCampaigns': 'Descobrir campanhas',
        'screen.createCampaign': 'Criar campanha',
        'screen.unavailable': 'Indisponível',
      },
      'zh-CN': {
        'manifest.name': 'FundMe',
        'manifest.description': '内置 BCH 众筹演示。',
        'app.fundmeApp.name': 'FundMe',
        'app.fundmeApp.description': '在 OPTN Wallet 中进行 BCH 众筹。',
        'screen.back': '返回',
        'screen.demo': '演示',
        'screen.discoverCampaigns': '浏览众筹活动',
        'screen.createCampaign': '创建众筹活动',
        'screen.unavailable': '不可用',
      },
      'zh-TW': {
        'manifest.name': 'FundMe',
        'manifest.description': '內建 BCH 群眾募資示範。',
        'app.fundmeApp.name': 'FundMe',
        'app.fundmeApp.description': '在 OPTN Wallet 中進行 BCH 群眾募資。',
        'screen.back': '返回',
        'screen.demo': '示範',
        'screen.discoverCampaigns': '瀏覽募資活動',
        'screen.createCampaign': '建立募資活動',
        'screen.unavailable': '無法使用',
      },
      vi: {
        'manifest.name': 'FundMe',
        'manifest.description':
          'Bản trình diễn gây quỹ cộng đồng BCH tích hợp.',
        'app.fundmeApp.name': 'FundMe',
        'app.fundmeApp.description': 'Gây quỹ cộng đồng BCH trong OPTN Wallet.',
        'screen.back': 'Quay lại',
        'screen.demo': 'Bản trình diễn',
        'screen.discoverCampaigns': 'Khám phá chiến dịch',
        'screen.createCampaign': 'Tạo chiến dịch',
        'screen.unavailable': 'Không khả dụng',
      },
      ar: {
        'manifest.name': 'FundMe',
        'manifest.description': 'عرض مضمّن للتمويل الجماعي باستخدام BCH.',
        'app.fundmeApp.name': 'FundMe',
        'app.fundmeApp.description':
          'تمويل جماعي باستخدام BCH داخل OPTN Wallet.',
        'screen.back': 'رجوع',
        'screen.demo': 'عرض تجريبي',
        'screen.discoverCampaigns': 'استكشاف الحملات',
        'screen.createCampaign': 'إنشاء حملة',
        'screen.unavailable': 'غير متاح',
      },
      fr: {
        'manifest.name': 'FundMe',
        'manifest.description':
          'Démonstration intégrée de financement participatif en BCH.',
        'app.fundmeApp.name': 'FundMe',
        'app.fundmeApp.description':
          'Financement participatif en BCH dans OPTN Wallet.',
        'screen.back': 'Retour',
        'screen.demo': 'Démonstration',
        'screen.discoverCampaigns': 'Découvrir les campagnes',
        'screen.createCampaign': 'Créer une campagne',
        'screen.unavailable': 'Indisponible',
      },
      ko: {
        'manifest.name': 'FundMe',
        'manifest.description': 'BCH 크라우드펀딩 기본 제공 데모입니다.',
        'app.fundmeApp.name': 'FundMe',
        'app.fundmeApp.description':
          'OPTN Wallet에서 BCH 크라우드펀딩을 이용합니다.',
        'screen.back': '뒤로',
        'screen.demo': '데모',
        'screen.discoverCampaigns': '캠페인 둘러보기',
        'screen.createCampaign': '캠페인 만들기',
        'screen.unavailable': '사용할 수 없음',
      },
      ja: {
        'manifest.name': 'FundMe',
        'manifest.description': 'BCHクラウドファンディングの組み込みデモです。',
        'app.fundmeApp.name': 'FundMe',
        'app.fundmeApp.description':
          'OPTN WalletでBCHのクラウドファンディングを行います。',
        'screen.back': '戻る',
        'screen.demo': 'デモ',
        'screen.discoverCampaigns': 'キャンペーンを探す',
        'screen.createCampaign': 'キャンペーンを作成',
        'screen.unavailable': '利用できません',
      },
      ru: {
        'manifest.name': 'FundMe',
        'manifest.description': 'Встроенная демонстрация краудфандинга на BCH.',
        'app.fundmeApp.name': 'FundMe',
        'app.fundmeApp.description': 'Краудфандинг на BCH в OPTN Wallet.',
        'screen.back': 'Назад',
        'screen.demo': 'Демонстрация',
        'screen.discoverCampaigns': 'Найти кампанию',
        'screen.createCampaign': 'Создать кампанию',
        'screen.unavailable': 'Недоступно',
      },
      'ha-NG': {
        'manifest.name': 'FundMe',
        'manifest.description':
          'Misalin tattara kuɗin jama’a na BCH da aka gina a ciki.',
        'app.fundmeApp.name': 'FundMe',
        'app.fundmeApp.description':
          'Tattara kuɗin jama’a na BCH a cikin OPTN Wallet.',
        'screen.back': 'Koma baya',
        'screen.demo': 'Misali',
        'screen.discoverCampaigns': 'Nemo kamfen',
        'screen.createCampaign': 'Ƙirƙiri kamfen',
        'screen.unavailable': 'Ba ya samuwa',
      },
    }),
  };

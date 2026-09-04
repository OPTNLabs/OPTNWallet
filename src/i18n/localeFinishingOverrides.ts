import type { BaseLocale, SupportedLocale } from './types';

type AddedLocale = Exclude<SupportedLocale, BaseLocale>;

/**
 * Shared wallet surfaces that are used by both the mobile and desktop apps.
 * Product, protocol, and chain vocabulary intentionally remains stable.
 */
export const localeFinishingOverrides: Partial<
  Record<AddedLocale, Record<string, string>>
> = {
  'pt-BR': {
    'assets.tabTokens': 'Tokens',
    'assets.plainNfts': 'NFTs simples',
    'assets.plainNftsDescription':
      'Compromisso fixo; não pode ser alterado nem usado para emitir',
    'assets.mutableNfts': 'NFTs mutáveis',
    'assets.mutableNftsDescription':
      'O compromisso pode ser alterado pelo titular',
    'assets.mintingNfts': 'NFTs de emissão',
    'assets.mintingNftsDescription':
      'Autoridade para emitir NFTs adicionais nesta categoria',
    'assets.units': 'unidades',
    'assets.openVaults': 'Abrir cofres',
    'assets.advancedVaultWorkspace': 'Área de trabalho avançada do cofre',
    'assets.vaultWorkspace': 'Área de trabalho do cofre',
    'assets.advancedVaultDescription':
      'Ferramentas de recebimento e recuperação para cofres avançados',
    'history.first': 'Primeira',
    'history.last': 'Última',
    'history.status': 'Status',
    'history.detailsUnavailable':
      'Os detalhes da transação não estão disponíveis no Electrum agora.',
    'history.loadDetailsFailed': 'Falha ao carregar os detalhes da transação.',
    'onboarding.helpCreateDescription':
      'Use esta opção para criar uma nova carteira com uma frase-semente nova neste dispositivo.',
    'onboarding.helpImportDescription':
      'Use esta opção se você já tem uma frase de recuperação de 12 palavras e quer acessar uma carteira existente.',
    'onboarding.helpNetworkDescription':
      'Selecione Mainnet para fundos reais ou CHIPNET para fundos de teste antes de continuar.',
    'onboarding.seedInstruction':
      'Anote estas 12 palavras na ordem e guarde-as em um local seguro. Qualquer pessoa com esta frase pode gastar seus fundos — nunca a compartilhe nem a armazene digitalmente.',
    'onboarding.confirmInstruction':
      'Digite as palavras solicitadas para confirmar que você as salvou corretamente.',
    'onboarding.confirmError':
      'As palavras não correspondem à sua frase-semente. Confira-as e tente novamente.',
    'onboarding.walletSetupDescription':
      'Escolha a rede e o caminho de endereços que esta carteira usará.',
    'onboarding.nameWalletDescription':
      'Dê um nome e uma senha para esta carteira. Cada carteira neste dispositivo tem sua própria senha independente.',
    'onboarding.walletAlreadyExists':
      'Esta carteira pode já existir neste dispositivo.',
    'onboarding.walletSavedIdFailed':
      'A carteira foi salva, mas não foi possível resolver o ID da carteira.',
    'onboarding.mnemonicLoading':
      'A frase de recuperação ainda está carregando. Aguarde um momento.',
    'onboarding.walletAlreadyAvailable':
      'Esta carteira já está disponível neste dispositivo.',
    'onboarding.databasePreparationFailed':
      'Não foi possível preparar a carteira neste dispositivo.',
    'onboarding.recoveryDescription':
      'Digite sua frase de recuperação BIP39 em inglês (12, 15, 18, 21 ou 24 palavras). Cada campo corresponde à ordem da palavra.',
    'onboarding.mnemonicWarning':
      'Sua frase de recuperação é a chave mestra da carteira. Guarde-a com segurança e nunca a compartilhe.',
    'console.appLog': 'Registro do app',
    'console.clear': 'Limpar',
    'console.noEntries': 'Ainda não há entradas no registro.',
    'console.typeHint':
      'Digite: método parâmetro1 parâmetro2 — por exemplo, server.version ou blockchain.headers.subscribe',
    'console.send': 'Enviar',
    'cauldron.positions': 'Posições do Cauldron',
    'cauldron.active': 'ativas',
    'cauldron.tokenCategories': 'categorias de tokens',
    'cauldron.description':
      'Detectadas no conjunto ativo de endereços de recebimento, troco e DeFi da carteira pelo indexador do Cauldron.',
    'txDetails.version': 'Versão',
    'txDetails.locktime': 'Tempo de bloqueio',
    'txDetails.index': 'Índice',
    'txSummary.token': 'token',
    'txSummary.bytes': 'bytes',
    'server.backend': 'Backend',
    'server.manual': 'Manual',
    'send.tokenLabel': 'Token',
    'send.token': 'Token',
    'send.airdrops': 'Distribuições',
    'send.totalBch': 'Total (BCH)',
    'send.bytes': 'bytes',
    'receive.quantumLock': 'Quantum Lock',
    'walkthrough.label': 'Passo a passo',
  },
  vi: {
    'assets.plainNfts': 'NFT thường',
    'assets.plainNftsDescription':
      'Cam kết cố định; không thể thay đổi hoặc dùng để đúc',
    'assets.mutableNfts': 'NFT có thể thay đổi',
    'assets.mutableNftsDescription': 'Chủ sở hữu có thể thay đổi cam kết',
    'assets.mintingNfts': 'NFT đúc',
    'assets.mintingNftsDescription': 'Quyền đúc thêm NFT trong danh mục này',
    'assets.units': 'đơn vị',
    'assets.openVaults': 'Mở vault',
    'assets.advancedVaultWorkspace': 'Không gian vault nâng cao',
    'assets.vaultWorkspace': 'Không gian vault',
    'assets.advancedVaultDescription':
      'Công cụ nhận và khôi phục cho vault nâng cao',
    'history.first': 'Đầu tiên',
    'history.last': 'Cuối cùng',
    'history.detailsUnavailable':
      'Hiện Electrum không cung cấp thông tin chi tiết giao dịch.',
    'history.loadDetailsFailed': 'Không thể tải thông tin chi tiết giao dịch.',
    'onboarding.helpCreateDescription':
      'Dùng tùy chọn này để tạo ví mới với cụm từ hạt giống mới trên thiết bị này.',
    'onboarding.helpImportDescription':
      'Dùng tùy chọn này nếu bạn đã có cụm từ khôi phục 12 từ và muốn truy cập ví hiện có.',
    'onboarding.helpNetworkDescription':
      'Chọn Mainnet cho tiền thật hoặc CHIPNET cho tiền thử nghiệm trước khi tiếp tục.',
    'onboarding.seedInstruction':
      'Ghi lại 12 từ này theo đúng thứ tự và cất ở nơi an toàn. Bất kỳ ai có cụm từ này đều có thể dùng tiền của bạn — không chia sẻ hoặc lưu cụm từ dưới dạng kỹ thuật số.',
    'onboarding.confirmInstruction':
      'Nhập các từ được yêu cầu để xác nhận bạn đã lưu đúng.',
    'onboarding.confirmError':
      'Các từ không khớp với cụm từ hạt giống. Hãy kiểm tra và thử lại.',
    'onboarding.walletSetupDescription':
      'Chọn mạng và đường dẫn địa chỉ mà ví này sẽ sử dụng.',
    'onboarding.nameWalletDescription':
      'Đặt tên và mật khẩu cho ví này. Mỗi ví trên thiết bị có mật khẩu độc lập riêng.',
    'onboarding.walletAlreadyExists': 'Ví này có thể đã tồn tại trên thiết bị.',
    'onboarding.walletSavedIdFailed':
      'Đã lưu ví nhưng không thể xác định ID của ví.',
    'onboarding.mnemonicLoading':
      'Cụm từ khôi phục vẫn đang tải. Vui lòng chờ một chút.',
    'onboarding.walletAlreadyAvailable': 'Ví này đã có sẵn trên thiết bị.',
    'onboarding.databasePreparationFailed':
      'Không thể chuẩn bị ví trên thiết bị này.',
    'onboarding.recoveryDescription':
      'Nhập cụm từ khôi phục BIP39 bằng tiếng Anh (12, 15, 18, 21 hoặc 24 từ). Mỗi ô tương ứng với thứ tự của một từ.',
    'onboarding.mnemonicWarning':
      'Cụm từ khôi phục là chìa khóa chính của ví. Hãy cất giữ an toàn và không bao giờ chia sẻ.',
    'console.appLog': 'Nhật ký ứng dụng',
    'console.clear': 'Xóa',
    'console.noEntries': 'Chưa có mục nhật ký nào.',
    'console.typeHint':
      'Nhập: phương_thức tham_số1 tham_số2 — ví dụ server.version hoặc blockchain.headers.subscribe',
    'console.send': 'Gửi',
    'cauldron.positions': 'Vị thế Cauldron',
    'cauldron.active': 'đang hoạt động',
    'cauldron.tokenCategories': 'danh mục token',
    'cauldron.description':
      'Được phát hiện từ nhóm địa chỉ nhận, tiền thừa và DeFi đang hoạt động của ví qua bộ lập chỉ mục Cauldron.',
    'txDetails.version': 'Phiên bản',
    'txDetails.locktime': 'Thời gian khóa',
    'txDetails.index': 'Chỉ mục',
    'txSummary.token': 'token',
    'server.backend': 'Backend',
    'server.node': 'Nút',
    'bip37.node': 'Nút',
    'send.tokenLabel': 'Token',
    'send.token': 'Token',
    'receive.quantumLock': 'Quantum Lock',
    'actions.quantumrootBadge': 'Bản beta sản phẩm',
    'walkthrough.label': 'Hướng dẫn từng bước',
  },
  'zh-TW': {
    'assets.plainNfts': '一般 NFT',
    'assets.plainNftsDescription': '固定承諾；無法變更或用於鑄造',
    'assets.mutableNfts': '可變更 NFT',
    'assets.mutableNftsDescription': '持有者可以變更承諾',
    'assets.mintingNfts': '鑄造 NFT',
    'assets.mintingNftsDescription': '可在此類別中鑄造其他 NFT 的權限',
    'assets.units': '單位',
    'assets.openVaults': '開啟保管庫',
    'assets.advancedVaultWorkspace': '進階保管庫工作區',
    'assets.vaultWorkspace': '保管庫工作區',
    'assets.advancedVaultDescription': '進階保管庫的接收與復原工具',
    'history.first': '第一頁',
    'history.last': '最後一頁',
    'history.detailsUnavailable': 'Electrum 目前無法提供交易詳細資料。',
    'history.loadDetailsFailed': '載入交易詳細資料失敗。',
    'onboarding.helpCreateDescription':
      '如果您要在此裝置上使用新的種子片語建立錢包，請選擇此選項。',
    'onboarding.helpImportDescription':
      '如果您已有 12 字的復原片語並要存取現有錢包，請選擇此選項。',
    'onboarding.helpNetworkDescription':
      '繼續前，請選擇用於真實資金的 Mainnet，或用於測試資金的 CHIPNET。',
    'onboarding.seedInstruction':
      '請依序寫下這 12 個單字並存放在安全處。任何擁有此片語的人都能花費您的資金 — 絕不要分享或以數位方式儲存。',
    'onboarding.confirmInstruction': '輸入指定單字，以確認您已正確儲存。',
    'onboarding.confirmError': '這些單字與您的種子片語不符。請檢查後再試。',
    'onboarding.walletSetupDescription': '選擇此錢包要使用的網路與地址路徑。',
    'onboarding.nameWalletDescription':
      '為此錢包命名並設定密碼。此裝置上的每個錢包都有獨立的密碼。',
    'onboarding.walletAlreadyExists': '此錢包可能已存在於此裝置。',
    'onboarding.walletSavedIdFailed': '錢包已儲存，但無法解析其錢包 ID。',
    'onboarding.mnemonicLoading': '復原片語仍在載入中，請稍候。',
    'onboarding.walletAlreadyAvailable': '此錢包已可在此裝置上使用。',
    'onboarding.databasePreparationFailed': '無法在此裝置上準備錢包。',
    'onboarding.recoveryDescription':
      '輸入英文 BIP39 復原片語（12、15、18、21 或 24 個單字）。每個欄位對應單字順序。',
    'onboarding.mnemonicWarning':
      '您的復原片語是錢包的主密鑰。請妥善保存，絕不要分享。',
    'console.appLog': '應用程式記錄',
    'console.clear': '清除',
    'console.noEntries': '尚無記錄項目。',
    'console.typeHint':
      '輸入：方法 參數1 參數2 — 例如 server.version 或 blockchain.headers.subscribe',
    'console.send': '傳送',
    'cauldron.positions': 'Cauldron 部位',
    'cauldron.active': '作用中',
    'cauldron.tokenCategories': '代幣類別',
    'cauldron.description':
      '由 Cauldron 索引器從目前錢包的接收、找零與 DeFi 地址集合中偵測。',
    'txDetails.version': '版本',
    'txDetails.locktime': '鎖定時間',
    'txDetails.index': '索引',
    'txSummary.token': '代幣',
    'faucet.name': 'Chipnet Faucet',
    'receive.quantumLock': 'Quantum Lock',
    'send.tokenLabel': '代幣',
    'send.token': '代幣',
    'settingsRows.faucet': 'Chipnet Faucet',
    'settingsPanels.faucet': 'Chipnet Faucet',
    'nftConfig.commitment': 'NFT 承諾',
    'rpa.title': 'RPA Cash Code',
    'actions.quantumrootBadge': 'Beta production',
    'walkthrough.label': '逐步導覽',
  },
  fr: {
    'assets.usdPriceUnavailable': 'Prix en USD indisponible',
    'assets.toggleBalance': 'Basculer entre les soldes BCH et USD',
    'assets.cashTokenHoldings': 'Avoirs en CashTokens',
    'assets.quickInventory': 'Vue rapide du contenu de votre portefeuille',
    'assets.fungible': 'fongibles',
    'assets.categories': 'catégories',
    'assets.fungibleHoldings': 'Avoirs en tokens fongibles',
    'assets.noFungibleTokens': 'Aucun CashToken fongible trouvé.',
    'assets.mintTokens': 'Émettre des tokens',
    'assets.nonFungibleHoldings': 'Avoirs non fongibles',
    'assets.plainNfts': 'NFT simples',
    'assets.plainNftsDescription':
      'Engagement fixe ; ne peut pas être modifié ni utilisé pour émettre',
    'assets.mutableNfts': 'NFT modifiables',
    'assets.mutableNftsDescription':
      'L’engagement peut être modifié par le détenteur',
    'assets.mintingNfts': 'NFT d’émission',
    'assets.mintingNftsDescription':
      'Autorité permettant d’émettre d’autres NFT dans cette catégorie',
    'assets.noNfts': 'Aucun NFT trouvé.',
    'assets.units': 'unités',
    'assets.openVaults': 'Ouvrir les coffres',
    'assets.advancedVaultWorkspace': 'Espace de travail avancé du coffre',
    'assets.vaultWorkspace': 'Espace de travail du coffre',
    'assets.advancedVaultDescription':
      'Outils de réception et de récupération pour les coffres avancés',
    'history.awaitingConfirmation': 'En attente de confirmation',
    'history.transaction': 'Transaction',
    'history.openExplorer': 'Ouvrir dans l’explorateur',
    'history.loadingDetails': 'Chargement des détails de la transaction…',
    'history.closeDetails': 'Fermer les détails',
    'history.detailsUnavailable':
      'Les détails de la transaction sont actuellement indisponibles depuis Electrum.',
    'history.loadDetailsFailed':
      'Échec du chargement des détails de la transaction.',
    'history.yourWallet': 'Votre portefeuille',
    'history.senders': 'Expéditeurs',
    'history.recipients': 'Destinataires',
    'history.unconfirmed': 'Non confirmée',
    'history.unknown': 'Inconnue',
    'history.unavailable': 'Indisponible',
    'history.confirmations': '{count} confirmations',
    'history.output': 'Sortie',
    'onboarding.helpCreateDescription':
      'Utilisez cette option pour créer un nouveau portefeuille avec une nouvelle phrase de départ sur cet appareil.',
    'onboarding.helpImportDescription':
      'Utilisez cette option si vous avez déjà une phrase de récupération de 12 mots et souhaitez accéder à un portefeuille existant.',
    'onboarding.helpNetworkDescription':
      'Sélectionnez Mainnet pour des fonds réels ou CHIPNET pour des fonds de test avant de continuer.',
    'onboarding.seedInstruction':
      'Notez ces 12 mots dans l’ordre et conservez-les en lieu sûr. Toute personne qui possède cette phrase peut dépenser vos fonds — ne la partagez jamais et ne la stockez pas numériquement.',
    'onboarding.confirmInstruction':
      'Saisissez les mots demandés pour confirmer que vous les avez correctement sauvegardés.',
    'onboarding.confirmError':
      'Ces mots ne correspondent pas à votre phrase de départ. Vérifiez-les et réessayez.',
    'onboarding.walletSetupDescription':
      'Choisissez le réseau et le chemin d’adresses utilisés par ce portefeuille.',
    'onboarding.nameWalletDescription':
      'Donnez un nom et un mot de passe à ce portefeuille. Chaque portefeuille de cet appareil possède son propre mot de passe indépendant.',
    'onboarding.walletAlreadyExists':
      'Ce portefeuille existe peut-être déjà sur cet appareil.',
    'onboarding.walletSavedIdFailed':
      'Le portefeuille a été enregistré, mais son identifiant n’a pas pu être résolu.',
    'onboarding.mnemonicLoading':
      'La phrase de récupération est encore en cours de chargement. Patientez un instant.',
    'onboarding.walletAlreadyAvailable':
      'Ce portefeuille est déjà disponible sur cet appareil.',
    'onboarding.databasePreparationFailed':
      'Impossible de préparer le portefeuille sur cet appareil.',
    'onboarding.missingWord': 'Le mot {number} est manquant.',
    'onboarding.recoveryDescription':
      'Saisissez votre phrase de récupération BIP39 en anglais (12, 15, 18, 21 ou 24 mots). Chaque champ correspond à l’ordre des mots.',
    'onboarding.wordCountLabel': 'Longueur de la phrase',
    'onboarding.words': 'mots',
    'onboarding.wordPlaceholder': 'mot',
    'onboarding.mnemonicWarning':
      'Votre phrase de récupération est la clé principale de votre portefeuille. Conservez-la en sécurité et ne la partagez jamais.',
    'console.appLog': 'Journal de l’application',
    'console.clear': 'Effacer',
    'console.noEntries': 'Aucune entrée de journal pour le moment.',
    'console.typeHint':
      'Saisissez : méthode paramètre1 paramètre2 — par exemple server.version ou blockchain.headers.subscribe',
    'console.send': 'Envoyer',
    'cauldron.positions': 'Positions Cauldron',
    'cauldron.active': 'actives',
    'cauldron.tokenCategories': 'catégories de tokens',
    'cauldron.description':
      'Détectées par l’indexeur Cauldron dans l’ensemble actif d’adresses de réception, de monnaie et DeFi du portefeuille.',
    'txDetails.version': 'Version',
    'txDetails.locktime': 'Délai de verrouillage',
    'txDetails.index': 'Index',
    'txSummary.token': 'token',
    'faucet.instructions': 'Instructions',
    'receive.quantumLock': 'Quantum Lock',
    'receive.message': 'Message',
    'send.tokenLabel': 'Token',
    'send.type': 'Type',
    'send.token': 'Token',
    'send.airdrops': 'Airdrops',
    'send.max': 'Max',
    'send.totalBch': 'Total (BCH)',
    'contractPopup.message': 'Message',
    'actions.title': 'Actions',
    'walkthrough.label': 'Guide pas à pas',
    'priceFeed.loading': 'Chargement…',
  },
  ko: {
    'assets.usdPriceUnavailable': 'USD 가격을 사용할 수 없음',
    'assets.toggleBalance': 'BCH 및 USD 잔액 전환',
    'assets.cashTokenHoldings': 'CashTokens 보유량',
    'assets.quickInventory': '지갑 자산 빠른 보기',
    'assets.fungible': '대체 가능',
    'assets.categories': '카테고리',
    'assets.fungibleHoldings': '대체 가능 토큰 보유량',
    'assets.noFungibleTokens': '대체 가능 CashToken이 없습니다.',
    'assets.mintTokens': '토큰 발행',
    'assets.nonFungibleHoldings': '대체 불가능 보유량',
    'assets.plainNfts': '일반 NFT',
    'assets.plainNftsDescription':
      '고정 커밋먼트로 변경하거나 발행에 사용할 수 없음',
    'assets.mutableNfts': '변경 가능한 NFT',
    'assets.mutableNftsDescription': '보유자가 커밋먼트를 변경할 수 있음',
    'assets.mintingNfts': '발행용 NFT',
    'assets.mintingNftsDescription': '이 카테고리에서 추가 NFT를 발행할 권한',
    'assets.noNfts': 'NFT가 없습니다.',
    'assets.units': '단위',
    'assets.openVaults': '볼트 열기',
    'assets.advancedVaultWorkspace': '고급 볼트 작업 공간',
    'assets.vaultWorkspace': '볼트 작업 공간',
    'assets.advancedVaultDescription': '고급 볼트를 위한 수신 및 복구 도구',
    'history.awaitingConfirmation': '확인 대기 중',
    'history.openExplorer': '탐색기에서 열기',
    'history.loadingDetails': '거래 세부 정보 로드 중…',
    'history.closeDetails': '세부 정보 닫기',
    'history.detailsUnavailable':
      '현재 Electrum에서 거래 세부 정보를 사용할 수 없습니다.',
    'history.loadDetailsFailed': '거래 세부 정보를 불러오지 못했습니다.',
    'history.yourWallet': '내 지갑',
    'history.senders': '송신자',
    'history.recipients': '수신자',
    'history.unconfirmed': '미확인',
    'history.unknown': '알 수 없음',
    'history.unavailable': '사용할 수 없음',
    'history.confirmations': '{count}회 확인',
    'history.output': '출력',
    'onboarding.helpCreateDescription':
      '이 장치에서 새 시드 문구로 새 지갑을 만들려면 사용하세요.',
    'onboarding.helpImportDescription':
      '12단어 복구 문구가 있고 기존 지갑에 접근하려면 사용하세요.',
    'onboarding.helpNetworkDescription':
      '계속하기 전에 실제 자금은 Mainnet, 테스트 자금은 CHIPNET을 선택하세요.',
    'onboarding.seedInstruction':
      '이 12개 단어를 순서대로 적어 안전한 곳에 보관하세요. 이 문구를 가진 사람은 누구나 자금을 사용할 수 있으므로 절대 공유하거나 디지털로 저장하지 마세요.',
    'onboarding.confirmInstruction':
      '저장한 단어가 올바른지 확인하기 위해 요청된 단어를 입력하세요.',
    'onboarding.confirmError':
      '단어가 시드 문구와 일치하지 않습니다. 확인하고 다시 시도하세요.',
    'onboarding.walletSetupDescription':
      '이 지갑에서 사용할 네트워크와 주소 경로를 선택하세요.',
    'onboarding.nameWalletDescription':
      '이 지갑의 이름과 비밀번호를 설정하세요. 이 장치의 각 지갑은 독립적인 비밀번호를 사용합니다.',
    'onboarding.walletAlreadyExists': '이 지갑이 장치에 이미 있을 수 있습니다.',
    'onboarding.walletSavedIdFailed':
      '지갑은 저장했지만 지갑 ID를 확인할 수 없습니다.',
    'onboarding.mnemonicLoading':
      '복구 문구를 아직 불러오는 중입니다. 잠시 기다리세요.',
    'onboarding.walletAlreadyAvailable':
      '이 지갑은 이미 이 장치에서 사용할 수 있습니다.',
    'onboarding.databasePreparationFailed':
      '이 장치에서 지갑을 준비하지 못했습니다.',
    'onboarding.missingWord': '{number}번째 단어가 없습니다.',
    'onboarding.recoveryDescription':
      '영어 BIP39 복구 문구(12, 15, 18, 21 또는 24단어)를 입력하세요. 각 상자는 단어 순서에 대응합니다.',
    'onboarding.wordCountLabel': '문구 길이',
    'onboarding.words': '단어',
    'onboarding.wordPlaceholder': '단어',
    'onboarding.mnemonicWarning':
      '복구 문구는 지갑의 마스터 키입니다. 안전하게 보관하고 절대 공유하지 마세요.',
    'bip37.node': '노드',
    'bip37.inUse': '● 사용 중',
    'bip37.useNodeTitle':
      '지갑 데이터에 이 노드만 사용(무신뢰 방식, Electrum 서버는 사용하지 않음)',
    'bip37.use': '사용',
    'bip37.probing': '확인 중…',
    'bip37.probe': '확인',
    'bip37.syncing': '동기화 중…',
    'bip37.sync': '동기화',
    'bip37.useBalanceTitle': '이 노드에서 지갑 잔액을 직접 파생(무신뢰 SPV)',
    'bip37.remove': '제거',
    'bip37.height': '높이',
    'bip37.protocol': '프로토콜',
    'bip37.serves': 'BIP37 제공 ✓',
    'bip37.notServes': 'BIP37을 제공하지 않음 ✗(블룸 필터링 꺼짐)',
    'bip37.syncingDetails': '노드를 통해 헤더를 동기화하고 블록을 스캔하는 중…',
    'bip37.fromNode': '노드의 BCH ✓',
    'bip37.scanned': '스캔됨',
    'bip37.blocks': '블록',
    'bip37.addressesWithCoins': '잔액이 있는 주소',
    'bip37.watching': '감시 중',
    'bip37.verified':
      '무신뢰 방식으로 확인됨: 일치하는 모든 거래가 블록의 머클 증명으로 검증되었습니다.',
    'console.appLog': '앱 로그',
    'console.clear': '지우기',
    'console.noEntries': '아직 로그 항목이 없습니다.',
    'console.typeHint':
      '입력: 메서드 매개변수1 매개변수2 — 예: server.version 또는 blockchain.headers.subscribe',
    'console.send': '보내기',
    'cauldron.positions': 'Cauldron 포지션',
    'cauldron.active': '활성',
    'cauldron.tokenCategories': '토큰 카테고리',
    'cauldron.description':
      'Cauldron 인덱서가 활성 지갑의 수신·잔돈·DeFi 주소 집합에서 감지했습니다.',
    'txDetails.version': '버전',
    'txDetails.locktime': '잠금 시간',
    'txDetails.index': '인덱스',
    'faucet.name': 'Chipnet Faucet',
    'receive.quantumLock': 'Quantum Lock',
    'send.tokenLabel': '토큰',
    'send.token': '토큰',
    'nftConfig.commitment': 'NFT 커밋먼트',
    'rpa.title': 'RPA Cash Code',
    'walkthrough.label': '단계별 안내',
    'priceFeed.loading': '로드 중…',
  },
  ja: {
    'assets.usdPriceUnavailable': 'USD 価格を取得できません',
    'assets.toggleBalance': 'BCH と USD の残高を切り替え',
    'assets.cashTokenHoldings': 'CashTokens の保有量',
    'assets.quickInventory': 'ウォレット資産のクイック表示',
    'assets.fungible': '代替可能',
    'assets.categories': 'カテゴリー',
    'assets.fungibleHoldings': '代替可能トークンの保有量',
    'assets.noFungibleTokens': '代替可能な CashToken はありません。',
    'assets.mintTokens': 'トークンを発行',
    'assets.nonFungibleHoldings': '代替不可能資産の保有量',
    'assets.plainNfts': '通常の NFT',
    'assets.plainNftsDescription':
      '固定コミットメント。変更や発行への利用はできません',
    'assets.mutableNfts': '変更可能な NFT',
    'assets.mutableNftsDescription': '保有者がコミットメントを変更できます',
    'assets.mintingNfts': '発行用 NFT',
    'assets.mintingNftsDescription':
      'このカテゴリーで追加の NFT を発行する権限',
    'assets.noNfts': 'NFT はありません。',
    'assets.units': '単位',
    'assets.openVaults': '保管庫を開く',
    'assets.advancedVaultWorkspace': '高度な保管庫ワークスペース',
    'assets.vaultWorkspace': '保管庫ワークスペース',
    'assets.advancedVaultDescription': '高度な保管庫の受取・復元ツール',
    'history.awaitingConfirmation': '確認待ち',
    'history.openExplorer': 'エクスプローラーで開く',
    'history.loadingDetails': '取引の詳細を読み込み中…',
    'history.closeDetails': '詳細を閉じる',
    'history.detailsUnavailable':
      '現在 Electrum から取引の詳細を取得できません。',
    'history.loadDetailsFailed': '取引の詳細を読み込めませんでした。',
    'history.yourWallet': '自分のウォレット',
    'history.senders': '送信元',
    'history.recipients': '送信先',
    'history.unconfirmed': '未確認',
    'history.unknown': '不明',
    'history.unavailable': '利用できません',
    'history.confirmations': '{count} 回の確認',
    'history.output': '出力',
    'onboarding.helpCreateDescription':
      'この端末で新しいシードフレーズを使ってウォレットを作成する場合に使用します。',
    'onboarding.helpImportDescription':
      '12 語の復元フレーズを持っていて、既存のウォレットにアクセスする場合に使用します。',
    'onboarding.helpNetworkDescription':
      '続行する前に、実際の資金には Mainnet、テスト資金には CHIPNET を選択してください。',
    'onboarding.seedInstruction':
      'この 12 語を順番どおりに書き留め、安全な場所に保管してください。このフレーズを知る人は誰でも資金を使えるため、絶対に共有したりデジタル保存したりしないでください。',
    'onboarding.confirmInstruction':
      '正しく保存したことを確認するため、指定された単語を入力してください。',
    'onboarding.confirmError':
      '単語がシードフレーズと一致しません。確認してもう一度お試しください。',
    'onboarding.walletSetupDescription':
      'このウォレットで使用するネットワークとアドレスパスを選択してください。',
    'onboarding.nameWalletDescription':
      'このウォレットに名前とパスワードを設定してください。この端末の各ウォレットには個別のパスワードがあります。',
    'onboarding.walletAlreadyExists':
      'このウォレットはすでに端末に存在する可能性があります。',
    'onboarding.walletSavedIdFailed':
      'ウォレットは保存されましたが、ウォレット ID を解決できませんでした。',
    'onboarding.mnemonicLoading':
      '復元フレーズを読み込んでいます。しばらくお待ちください。',
    'onboarding.walletAlreadyAvailable':
      'このウォレットはすでに端末で利用できます。',
    'onboarding.databasePreparationFailed':
      'この端末でウォレットを準備できませんでした。',
    'onboarding.missingWord': '{number} 番目の単語がありません。',
    'onboarding.recoveryDescription':
      '英語の BIP39 復元フレーズ（12、15、18、21、または 24 語）を入力してください。各欄は単語の順序に対応します。',
    'onboarding.wordCountLabel': 'フレーズの長さ',
    'onboarding.words': '語',
    'onboarding.wordPlaceholder': '単語',
    'onboarding.mnemonicWarning':
      '復元フレーズはウォレットのマスターキーです。安全に保管し、絶対に共有しないでください。',
    'bip37.node': 'ノード',
    'bip37.inUse': '● 使用中',
    'bip37.useNodeTitle':
      'ウォレットデータにはこのノードだけを使用（トラストレス。Electrum サーバーは使用しません）',
    'bip37.use': '使用',
    'bip37.probing': '確認中…',
    'bip37.probe': '確認',
    'bip37.syncing': '同期中…',
    'bip37.sync': '同期',
    'bip37.useBalanceTitle':
      'このノードからウォレット残高を直接導出（トラストレス SPV）',
    'bip37.remove': '削除',
    'bip37.height': '高さ',
    'bip37.protocol': 'プロトコル',
    'bip37.serves': 'BIP37 を提供 ✓',
    'bip37.notServes': 'BIP37 を提供しません ✗（ブルームフィルター無効）',
    'bip37.syncingDetails':
      'ノード経由でヘッダーを同期し、ブロックをスキャン中…',
    'bip37.fromNode': 'ノードからの BCH ✓',
    'bip37.scanned': 'スキャン済み',
    'bip37.blocks': 'ブロック',
    'bip37.addressesWithCoins': '残高のあるアドレス',
    'bip37.watching': '監視中',
    'bip37.verified':
      'トラストレスで確認済み。一致したすべての取引がブロックのマークル証明で検証されています。',
    'console.appLog': 'アプリログ',
    'console.clear': 'クリア',
    'console.noEntries': 'ログ項目はまだありません。',
    'console.typeHint':
      '入力：メソッド パラメーター1 パラメーター2 — 例：server.version または blockchain.headers.subscribe',
    'console.send': '送信',
    'cauldron.positions': 'Cauldron ポジション',
    'cauldron.active': '有効',
    'cauldron.tokenCategories': 'トークンカテゴリー',
    'cauldron.description':
      'Cauldron インデクサーが、ウォレットで有効な受取・おつり・DeFi アドレスから検出しました。',
    'txDetails.version': 'バージョン',
    'txDetails.locktime': 'ロック時間',
    'txDetails.index': 'インデックス',
    'txSummary.token': 'トークン',
    'faucet.name': 'Chipnet Faucet',
    'receive.quantumLock': 'Quantum Lock',
    'send.tokenLabel': 'トークン',
    'send.token': 'トークン',
    'nftConfig.commitment': 'NFT コミットメント',
    'nostr.relays': 'リレー',
    'rpa.title': 'RPA Cash Code',
    'walkthrough.label': 'ステップガイド',
    'priceFeed.loading': '読み込み中…',
  },
  ru: {
    'assets.usdPriceUnavailable': 'Цена в USD недоступна',
    'assets.toggleBalance': 'Переключить баланс BCH и USD',
    'assets.cashTokenHoldings': 'Баланс CashTokens',
    'assets.quickInventory': 'Быстрый обзор активов кошелька',
    'assets.fungible': 'взаимозаменяемые',
    'assets.categories': 'категории',
    'assets.fungibleHoldings': 'Баланс взаимозаменяемых токенов',
    'assets.noFungibleTokens': 'Взаимозаменяемые CashTokens не найдены.',
    'assets.mintTokens': 'Выпустить токены',
    'assets.nonFungibleHoldings': 'Баланс невзаимозаменяемых активов',
    'assets.plainNfts': 'Обычные NFT',
    'assets.plainNftsDescription':
      'Фиксированное обязательство; нельзя изменить или использовать для выпуска',
    'assets.mutableNfts': 'Изменяемые NFT',
    'assets.mutableNftsDescription': 'Владелец может изменить обязательство',
    'assets.mintingNfts': 'NFT для выпуска',
    'assets.mintingNftsDescription':
      'Полномочие выпускать дополнительные NFT в этой категории',
    'assets.noNfts': 'NFT не найдены.',
    'assets.units': 'единицы',
    'assets.openVaults': 'Открыть хранилища',
    'assets.advancedVaultWorkspace': 'Расширенная рабочая область хранилища',
    'assets.vaultWorkspace': 'Рабочая область хранилища',
    'assets.advancedVaultDescription':
      'Инструменты получения и восстановления для расширенных хранилищ',
    'history.awaitingConfirmation': 'Ожидание подтверждения',
    'history.openExplorer': 'Открыть в обозревателе',
    'history.loadingDetails': 'Загрузка сведений о транзакции…',
    'history.closeDetails': 'Закрыть сведения',
    'history.detailsUnavailable':
      'Сведения о транзакции сейчас недоступны из Electrum.',
    'history.loadDetailsFailed': 'Не удалось загрузить сведения о транзакции.',
    'history.yourWallet': 'Ваш кошелёк',
    'history.senders': 'Отправители',
    'history.recipients': 'Получатели',
    'history.unconfirmed': 'Неподтверждённая',
    'history.unknown': 'Неизвестная',
    'history.unavailable': 'Недоступна',
    'history.confirmations': 'Подтверждений: {count}',
    'history.output': 'Выход',
    'onboarding.welcomeAlt': 'Кошелёк Smart BCH',
    'onboarding.helpCreateDescription':
      'Выберите этот вариант, чтобы создать новый кошелёк с новой сид-фразой на этом устройстве.',
    'onboarding.helpImportDescription':
      'Выберите этот вариант, если у вас уже есть фраза восстановления из 12 слов и нужен доступ к существующему кошельку.',
    'onboarding.helpNetworkDescription':
      'Перед продолжением выберите Mainnet для реальных средств или CHIPNET для тестовых средств.',
    'onboarding.seedInstruction':
      'Запишите эти 12 слов по порядку и храните их в безопасном месте. Любой, у кого есть эта фраза, может потратить ваши средства — никогда не сообщайте её и не храните в цифровом виде.',
    'onboarding.confirmInstruction':
      'Введите запрошенные слова, чтобы подтвердить правильность сохранения.',
    'onboarding.confirmError':
      'Слова не совпадают с сид-фразой. Проверьте их и повторите попытку.',
    'onboarding.walletSetupDescription':
      'Выберите сеть и путь адресов, которые будет использовать этот кошелёк.',
    'onboarding.nameWalletDescription':
      'Задайте кошельку имя и пароль. Каждый кошелёк на этом устройстве имеет отдельный пароль.',
    'onboarding.walletAlreadyExists':
      'Возможно, этот кошелёк уже существует на устройстве.',
    'onboarding.walletSavedIdFailed':
      'Кошелёк сохранён, но не удалось определить его ID.',
    'onboarding.mnemonicLoading':
      'Фраза восстановления всё ещё загружается. Подождите немного.',
    'onboarding.walletAlreadyAvailable':
      'Этот кошелёк уже доступен на устройстве.',
    'onboarding.databasePreparationFailed':
      'Не удалось подготовить кошелёк на этом устройстве.',
    'onboarding.missingWord': 'Отсутствует слово {number}.',
    'onboarding.recoveryDescription':
      'Введите английскую фразу восстановления BIP39 (12, 15, 18, 21 или 24 слова). Каждое поле соответствует порядку слова.',
    'onboarding.wordCountLabel': 'Длина фразы',
    'onboarding.words': 'слов',
    'onboarding.wordPlaceholder': 'слово',
    'onboarding.mnemonicWarning':
      'Фраза восстановления — главный ключ вашего кошелька. Храните её в безопасности и никогда не сообщайте.',
    'bip37.node': 'Узел',
    'bip37.inUse': '● используется',
    'bip37.useNodeTitle':
      'Использовать ТОЛЬКО этот узел для данных кошелька (без доверия; серверы Electrum не используются)',
    'bip37.use': 'Использовать',
    'bip37.probing': 'Проверка…',
    'bip37.probe': 'Проверить',
    'bip37.syncing': 'Синхронизация…',
    'bip37.sync': 'Синхронизировать',
    'bip37.useBalanceTitle':
      'Получать баланс кошелька напрямую из узла (SPV без доверия)',
    'bip37.remove': 'Удалить',
    'bip37.height': 'высота',
    'bip37.protocol': 'протокол',
    'bip37.serves': 'Поддерживает BIP37 ✓',
    'bip37.notServes': 'Не поддерживает BIP37 ✗ (фильтрация Блума отключена)',
    'bip37.syncingDetails':
      'Синхронизация заголовков и сканирование блоков через узел…',
    'bip37.fromNode': 'BCH из узла ✓',
    'bip37.scanned': 'просканировано',
    'bip37.blocks': 'блоков',
    'bip37.addressesWithCoins': 'адресов со средствами',
    'bip37.watching': 'отслеживается',
    'bip37.verified':
      'Проверено без доверия: каждая найденная транзакция подтверждена меркль-доказательством блока.',
    'console.appLog': 'Журнал приложения',
    'console.clear': 'Очистить',
    'console.noEntries': 'Записей в журнале пока нет.',
    'console.typeHint':
      'Введите: метод параметр1 параметр2 — например server.version или blockchain.headers.subscribe',
    'console.send': 'Отправить',
    'cauldron.positions': 'Позиции Cauldron',
    'cauldron.active': 'активны',
    'cauldron.tokenCategories': 'категории токенов',
    'cauldron.description':
      'Обнаружены индексатором Cauldron в активном наборе адресов получения, сдачи и DeFi кошелька.',
    'txDetails.version': 'Версия',
    'txDetails.locktime': 'Время блокировки',
    'txDetails.index': 'Индекс',
    'nostr.relays': 'Ретрансляторы',
    'receive.quantumLock': 'Quantum Lock',
    'send.tokenLabel': 'Токен',
    'send.token': 'Токен',
    'walkthrough.label': 'Пошаговое руководство',
    'priceFeed.loading': 'Загрузка…',
  },
  'ha-NG': {
    'assets.usdPriceUnavailable': 'Farashin USD ba ya samuwa',
    'assets.toggleBalance': 'Canja tsakanin ma’aunin BCH da USD',
    'assets.cashTokenHoldings': 'CashTokens da ke cikin wallet',
    'assets.quickInventory': 'Saurin duba kadarorin wallet',
    'assets.fungible': 'masu musanyawa',
    'assets.categories': 'rukuni',
    'assets.fungibleHoldings': 'Token masu musanyawa da ke cikin wallet',
    'assets.noFungibleTokens': 'Ba a sami CashToken mai musanyawa ba.',
    'assets.mintTokens': 'Fitar da tokens',
    'assets.nonFungibleHoldings': 'Kadarorin da ba sa musanyawa',
    'assets.plainNfts': 'NFT na yau da kullum',
    'assets.plainNftsDescription':
      'Alƙawari tabbatacce; ba za a iya canja shi ko amfani da shi wajen fitarwa ba',
    'assets.mutableNfts': 'NFT masu canzawa',
    'assets.mutableNftsDescription': 'Mai riƙewa zai iya canja alƙawarin',
    'assets.mintingNfts': 'NFT na fitarwa',
    'assets.mintingNftsDescription': 'Ikon fitar da ƙarin NFT a wannan rukuni',
    'assets.noNfts': 'Ba a sami NFT ba.',
    'assets.units': 'raka’a',
    'assets.openVaults': 'Buɗe vaults',
    'assets.advancedVaultWorkspace': 'Wurin aiki na vault mai ci gaba',
    'assets.vaultWorkspace': 'Wurin aiki na vault',
    'assets.advancedVaultDescription':
      'Kayan karɓa da dawo da vaults masu ci gaba',
    'history.awaitingConfirmation': 'Ana jiran tabbatarwa',
    'history.openExplorer': 'Buɗe a explorer',
    'history.loadingDetails': 'Ana loda bayanan ciniki…',
    'history.closeDetails': 'Rufe bayanai',
    'history.detailsUnavailable':
      'Bayanan ciniki ba sa samuwa daga Electrum a yanzu.',
    'history.loadDetailsFailed': 'An kasa loda bayanan ciniki.',
    'history.yourWallet': 'Wallet ɗinka',
    'history.senders': 'Masu aikawa',
    'history.recipients': 'Masu karɓa',
    'history.unconfirmed': 'Ba a tabbatar ba',
    'history.unknown': 'Ba a sani ba',
    'history.unavailable': 'Ba ya samuwa',
    'history.confirmations': 'tabbatarwa {count}',
    'history.output': 'Fitarwa',
    'onboarding.welcomeAlt': 'Smart BCH Wallet',
    'onboarding.helpCreateDescription':
      'Yi amfani da wannan idan kana son ƙirƙirar sabon wallet da sabuwar kalmar iri a wannan na’ura.',
    'onboarding.helpImportDescription':
      'Yi amfani da wannan idan kana da kalmomin dawo da 12 kuma kana son samun damar wallet da ke akwai.',
    'onboarding.helpNetworkDescription':
      'Zaɓi Mainnet don kuɗi na gaske ko CHIPNET don kuɗin gwaji kafin ka ci gaba.',
    'onboarding.seedInstruction':
      'Rubuta waɗannan kalmomi 12 bisa tsari kuma ajiye su a wuri mai aminci. Duk wanda ya mallaki wannan jimla zai iya kashe kuɗinka — kada ka taɓa raba ta ko adana ta a na’ura.',
    'onboarding.confirmInstruction':
      'Shigar da kalmomin da aka nema don tabbatar da ka adana su daidai.',
    'onboarding.confirmError':
      'Kalmomin ba su dace da kalmar iri ba. Duba su ka sake gwadawa.',
    'onboarding.walletSetupDescription':
      'Zaɓi hanyar sadarwa da hanyar adireshi da wannan wallet zai yi amfani da su.',
    'onboarding.nameWalletDescription':
      'Ba wa wannan wallet suna da kalmar sirri. Kowane wallet a wannan na’ura yana da kalmar sirri mai zaman kanta.',
    'onboarding.walletAlreadyExists':
      'Wataƙila wannan wallet ya riga ya kasance a wannan na’ura.',
    'onboarding.walletSavedIdFailed':
      'An adana wallet, amma ba a iya gano ID ɗinsa ba.',
    'onboarding.mnemonicLoading':
      'Har yanzu ana loda kalmomin dawo da wallet. Jira kaɗan.',
    'onboarding.walletAlreadyAvailable':
      'Wannan wallet ya riga ya kasance a kan na’urar.',
    'onboarding.databasePreparationFailed':
      'An kasa shirya wallet a wannan na’ura.',
    'onboarding.missingWord': 'Kalma ta {number} ta ɓace.',
    'onboarding.recoveryDescription':
      'Shigar da kalmomin dawo da BIP39 na Turanci (12, 15, 18, 21 ko 24). Kowane akwati yana wakiltar tsarin kalma.',
    'onboarding.wordCountLabel': 'Tsawon jimla',
    'onboarding.words': 'kalmomi',
    'onboarding.wordPlaceholder': 'kalma',
    'onboarding.mnemonicWarning':
      'Kalmomin dawo da wallet su ne babban mabuɗin wallet ɗinka. Ajiye su lafiya kuma kada ka taɓa raba su.',
    'bip37.node': 'Node',
    'bip37.inUse': '● ana amfani da shi',
    'bip37.useNodeTitle':
      'Yi amfani da wannan node KAWAI don bayanan wallet (ba tare da dogaro ba; ba a tuntubar servers na Electrum)',
    'bip37.use': 'Yi amfani',
    'bip37.probing': 'Ana bincika…',
    'bip37.probe': 'Bincika',
    'bip37.syncing': 'Ana daidaitawa…',
    'bip37.sync': 'Daidaita',
    'bip37.useBalanceTitle':
      'Fitar da ma’aunin wallet kai tsaye daga node (SPV marar dogaro)',
    'bip37.remove': 'Cire',
    'bip37.height': 'tsawo',
    'bip37.protocol': 'yarjejeniya',
    'bip37.serves': 'Yana hidimar BIP37 ✓',
    'bip37.notServes': 'Ba ya hidimar BIP37 ✗ (an kashe bloom filtering)',
    'bip37.syncingDetails': 'Ana daidaita headers da binciken blocks ta node…',
    'bip37.fromNode': 'BCH daga node ✓',
    'bip37.scanned': 'an bincika',
    'bip37.blocks': 'blocks',
    'bip37.addressesWithCoins': 'adireshi masu kuɗi',
    'bip37.watching': 'ana sa ido',
    'bip37.verified':
      'An tabbatar ba tare da dogaro ba: an tabbatar da kowace ciniki da ta dace ta merkle proof na block ɗinta.',
    'console.appLog': 'Littafin ayyukan manhaja',
    'console.clear': 'Share',
    'console.noEntries': 'Babu shigarwa a littafin ayyuka tukuna.',
    'console.typeHint':
      'Rubuta: hanya siga1 siga2 — misali server.version ko blockchain.headers.subscribe',
    'console.send': 'Aika',
    'cauldron.positions': 'Matsayi na Cauldron',
    'cauldron.active': 'masu aiki',
    'cauldron.tokenCategories': 'rukunan token',
    'cauldron.description':
      'Indexer na Cauldron ya gano su daga rukunin adireshin karɓa, canji da DeFi na wallet mai aiki.',
    'txDetails.version': 'Sigar',
    'txDetails.locktime': 'Lokacin kullewa',
    'txDetails.index': 'Fihirisa',
    'txSummary.token': 'token',
    'txSummary.bytes': 'bytes',
    'faucet.name': 'Chipnet Faucet',
    'receive.quantumLock': 'Quantum Lock',
    'send.tokenLabel': 'Token',
    'send.token': 'Token',
    'send.airdrops': 'Rarrabawa',
    'send.bytes': 'bytes',
    'settingsRows.faucet': 'Chipnet Faucet',
    'settingsRows.console': 'Console',
    'settingsPanels.server': 'Server',
    'settingsPanels.console': 'Console',
    'settingsPanels.faucet': 'Chipnet Faucet',
    'apps.wallet': 'Wallet',
    'apps.token': 'Token',
    'walkthrough.label': 'Jagorar mataki-mataki',
    'priceFeed.loading': 'Ana lodawa…',
  },
};

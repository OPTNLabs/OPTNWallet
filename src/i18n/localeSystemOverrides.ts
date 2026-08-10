import type { BaseLocale, SupportedLocale } from './types';

type AddedLocale = Exclude<SupportedLocale, BaseLocale>;

/** Desktop wallet selection and settings panels owned by the wallet shell. */
export const localeSystemOverrides: Partial<
  Record<AddedLocale, Record<string, string>>
> = {
  'pt-BR': {
    'desktopWallet.biometricUnlock': 'Desbloqueio biométrico',
    'desktopWallet.alreadyOpen':
      'Essa carteira já está aberta em outra janela.',
    'desktopWallet.biometricFailed':
      'Falha no desbloqueio biométrico: {message}',
    'desktopWallet.incorrectFilePassword':
      'Senha incorreta para este arquivo de carteira.',
    'desktopWallet.importFailed':
      'Não foi possível importar este arquivo de carteira.',
    'desktopWallet.openFailed':
      'Não foi possível abrir esta carteira. Tente novamente.',
    'desktopWallet.hardwareTitle': 'Conectar carteira de hardware',
    'desktopWallet.device': 'Dispositivo',
    'desktopWallet.hardwareDescription':
      'Será usado automaticamente para assinar envios de carteiras de software enquanto estiver conectado. Carteiras somente de hardware, com endereços próprios de recebimento, ainda não são compatíveis.',
    'desktopWallet.backToWallets': 'Voltar às carteiras',
    'desktopWallet.openFile': 'Abrir “{name}”',
    'desktopWallet.filePasswordDescription':
      'Insira a senha deste arquivo de carteira.',
    'desktopWallet.password': 'Senha',
    'desktopWallet.cancel': 'Cancelar',
    'desktopWallet.open': 'Abrir',
    'desktopWallet.opening': 'Abrindo…',
    'desktopWallet.yourWallets': 'Suas carteiras',
    'desktopWallet.walletNumber': 'Carteira #{id}',
    'desktopWallet.openButton': 'Abrir',
    'desktopWallet.deleteLabel': 'Excluir {name}',
    'desktopWallet.deleteConfirm':
      'Excluir “{name}” ({network}, #{id})? O arquivo .optn salvo será mantido para que você possa importá-lo novamente.',
    'desktopWallet.delete': 'Excluir',
    'desktopWallet.deleting': 'Excluindo…',
    'desktopWallet.unlock': 'Desbloquear',
    'desktopWallet.unlocking': 'Desbloqueando…',
    'desktopWallet.useBiometric': 'Usar {label}',
    'desktopWallet.addAnother': 'Adicionar outra carteira',
    'settingsDerivation.description':
      'O OPTN aceita um caminho de conta BIP44 ativo por vez. Reconfigurá-lo remove os registros derivados antigos e faz uma nova descoberta e sincronização de recebimento e troco.',
    'settingsDerivation.activePath': 'Caminho de conta BIP44 ativo',
    'settingsDerivation.currentMode': 'Modo atual: {mode}.',
    'settingsDerivation.custom': 'personalizado',
    'settingsDerivation.networkDefault': 'padrão da rede',
    'settingsDerivation.invalidPath': 'Caminho de derivação inválido.',
    'settingsDerivation.alreadyActive':
      'Este caminho de derivação já está ativo.',
    'settingsDerivation.confirm':
      'Alterar o caminho de derivação limpa os registros atuais de endereços, histórico e UTXOs. A carteira regenerará e sincronizará somente o novo caminho. Continuar?',
    'settingsDerivation.completed':
      'Caminho de derivação alterado e sincronização da carteira concluída.',
    'settingsDerivation.failed': 'Falha na reconfiguração da carteira.',
    'settingsDerivation.reconfiguring': 'Reconfigurando…',
    'settingsDerivation.changeResync': 'Alterar e sincronizar novamente',
    'settingsDerivation.useDefault': 'Usar padrão da rede',
    'experimental.features': 'Recursos experimentais',
    'experimental.description':
      'Esses recursos estão em desenvolvimento ativo. Ative-os para testar novas capacidades — podem mudar ou ficar incompletos em atualizações futuras.',
    'experimental.disable': 'Desativar',
    'experimental.enable': 'Ativar',
    'experimental.quantumSafe': 'Resistente a quantum',
    'experimental.quantumDescription':
      'Os cofres Quantumroot protegem fundos com um esquema Schnorr LM-OTS resistente a quantum. Ativado por padrão. Desative para ocultar o Quantumroot se não o usar.',
    'experimental.rpaTitle': 'Endereços de pagamento reutilizáveis (RPA)',
    'experimental.rpaBadge': 'BCH RPA',
    'experimental.rpaDescription':
      'Gera um Paycode estático (paycode:q...) que você pode compartilhar publicamente. Remetentes derivam um endereço exclusivo para cada pagamento via ECDH — sem transação de notificação e sem inchaço da cadeia. Fundos furtivos recebidos aparecem separadamente como “BCH furtivo”. A varredura exige um servidor compatível com Fulcrum-RPA.',
    'experimental.rpaWarning':
      'Enviar para Paycodes exige grinding de assinatura (ainda não implementado). Recebimento e varredura estão disponíveis.',
    'experimental.privacy': 'Privacidade',
    'experimental.cashFusionDescription':
      'CashFusion é um protocolo de privacidade sem custódia que combina seus UTXOs com os de outros usuários para quebrar o vínculo do histórico de transações. Conecte-se a um servidor CashFusion para participar. Seus fundos nunca ficam em risco — o protocolo não exige confiança.',
    'experimental.cashFusionWarning':
      'Exige uma conexão ativa a um servidor CashFusion. Em breve — o alternador está reservado no momento.',
    'p2p.title': 'Fusion P2P via Nostr',
    'p2p.description':
      'Sem servidor: pares se encontram em relays Nostr via Tor, elegem um coordenador determinístico e executam o CoinJoin ponto a ponto. As saídas não podem ser vinculadas; você assina apenas suas entradas após verificar suas saídas.',
    'p2p.running': 'Executando rodada P2P…',
    'p2p.start': 'Iniciar rodada P2P',
    'p2p.requiresPeers': 'Exige Tor e pelo menos 2 pares na mesma categoria.',
    'p2p.phase.announce': 'Anunciando e encontrando pares',
    'p2p.phase.register': 'Registrando entradas e saídas',
    'p2p.phase.assemble': 'Montando e verificando',
    'p2p.phase.sign': 'Assinando',
    'p2p.phase.broadcast': 'Transmitindo',
    'settingsPanels.contract': 'Informações do contrato',
    'settingsPanels.appLock': 'Bloqueio do app',
    'settingsPanels.server': 'Servidor',
    'settingsPanels.derivation': 'Caminho de derivação',
    'settingsPanels.console': 'Console',
    'settingsPanels.experimental': 'Recursos experimentais',
    'settingsPanels.cashfusion': 'CashFusion',
    'settingsPanels.nostr': 'Nostr e chat',
    'settingsPanels.addons': 'Add-ons',
    'settingsPanels.walletConnect': 'WalletConnect',
    'settingsPanels.wizardConnect': 'WizardConnect',
    'settingsPanels.faucet': 'Faucet do Chipnet',
    'addons.installed': 'Add-ons instalados',
    'addons.description':
      'Add-ons executam em um frame isolado, sem acesso às chaves ou à memória da carteira — só podem fazer o que as permissões aprovadas permitem.',
    'addons.none': 'Nenhum add-on instalado.',
    'addons.uninstall': 'Desinstalar',
    'addons.installedStatus':
      '“{name}” instalado. Reinicie o app para carregá-lo.',
    'addons.uninstalledStatus':
      'Desinstalado. Reinicie o app para removê-lo completamente.',
    'addons.installing': 'Instalando…',
    'addons.installFolder': 'Instalar de uma pasta…',
    'addons.desktopOnly':
      'Instalar add-ons de uma pasta só está disponível no desktop.',
  },
  vi: {
    'desktopWallet.biometricUnlock': 'Mở khóa sinh trắc học',
    'desktopWallet.alreadyOpen': 'Ví này đã mở trong cửa sổ khác.',
    'desktopWallet.biometricFailed':
      'Mở khóa sinh trắc học thất bại: {message}',
    'desktopWallet.incorrectFilePassword':
      'Mật khẩu cho tệp ví này không đúng.',
    'desktopWallet.importFailed': 'Không thể nhập tệp ví này.',
    'desktopWallet.openFailed': 'Không thể mở ví này. Hãy thử lại.',
    'desktopWallet.hardwareTitle': 'Kết nối ví phần cứng',
    'desktopWallet.device': 'Thiết bị',
    'desktopWallet.hardwareDescription':
      'Thiết bị sẽ tự động ký lượt gửi từ ví phần mềm khi được kết nối. Ví chỉ phần cứng có địa chỉ nhận riêng chưa được hỗ trợ.',
    'desktopWallet.backToWallets': 'Quay lại ví',
    'desktopWallet.openFile': 'Mở “{name}”',
    'desktopWallet.filePasswordDescription': 'Nhập mật khẩu của tệp ví này.',
    'desktopWallet.password': 'Mật khẩu',
    'desktopWallet.cancel': 'Hủy',
    'desktopWallet.open': 'Mở',
    'desktopWallet.opening': 'Đang mở…',
    'desktopWallet.yourWallets': 'Ví của bạn',
    'desktopWallet.walletNumber': 'Ví #{id}',
    'desktopWallet.openButton': 'Mở',
    'desktopWallet.deleteLabel': 'Xóa {name}',
    'desktopWallet.deleteConfirm':
      'Xóa “{name}” ({network}, #{id})? Tệp .optn đã lưu vẫn được giữ để bạn có thể nhập lại.',
    'desktopWallet.delete': 'Xóa',
    'desktopWallet.deleting': 'Đang xóa…',
    'desktopWallet.unlock': 'Mở khóa',
    'desktopWallet.unlocking': 'Đang mở khóa…',
    'desktopWallet.useBiometric': 'Dùng {label}',
    'desktopWallet.addAnother': 'Thêm ví khác',
    'settingsDerivation.description':
      'OPTN chỉ hỗ trợ một đường dẫn tài khoản BIP44 hoạt động mỗi lần. Cấu hình lại sẽ xóa bản ghi dẫn xuất cũ, khám phá lại địa chỉ nhận/tiền thừa và đồng bộ lại.',
    'settingsDerivation.activePath': 'Đường dẫn tài khoản BIP44 hoạt động',
    'settingsDerivation.currentMode': 'Chế độ hiện tại: {mode}.',
    'settingsDerivation.custom': 'tùy chỉnh',
    'settingsDerivation.networkDefault': 'mặc định mạng',
    'settingsDerivation.invalidPath': 'Đường dẫn dẫn xuất không hợp lệ.',
    'settingsDerivation.alreadyActive': 'Đường dẫn này đã hoạt động.',
    'settingsDerivation.confirm':
      'Đổi đường dẫn sẽ xóa địa chỉ, lịch sử và UTXO hiện tại. Ví sẽ tạo lại và đồng bộ chỉ đường dẫn mới. Tiếp tục?',
    'settingsDerivation.completed': 'Đã đổi đường dẫn và đồng bộ ví xong.',
    'settingsDerivation.failed': 'Cấu hình lại ví thất bại.',
    'settingsDerivation.reconfiguring': 'Đang cấu hình lại…',
    'settingsDerivation.changeResync': 'Đổi và đồng bộ lại',
    'settingsDerivation.useDefault': 'Dùng mặc định mạng',
    'experimental.features': 'Tính năng thử nghiệm',
    'experimental.description':
      'Các tính năng này đang được phát triển. Bật để thử khả năng mới — chúng có thể thay đổi hoặc chưa hoàn chỉnh trong bản cập nhật sau.',
    'experimental.disable': 'Tắt',
    'experimental.enable': 'Bật',
    'experimental.quantumSafe': 'An toàn trước lượng tử',
    'experimental.quantumDescription':
      'Vault Quantumroot bảo vệ tiền bằng sơ đồ Schnorr LM-OTS chống lượng tử. Mặc định bật. Tắt để ẩn Quantumroot nếu bạn không dùng.',
    'experimental.rpaTitle': 'Địa chỉ thanh toán tái sử dụng (RPA)',
    'experimental.rpaBadge': 'BCH RPA',
    'experimental.rpaDescription':
      'Tạo Paycode tĩnh (paycode:q...) để chia sẻ công khai. Người gửi dẫn xuất địa chỉ dùng một lần cho mỗi khoản thanh toán qua ECDH — không có giao dịch thông báo và không làm phình chuỗi. Tiền ẩn nhận được hiển thị riêng là “BCH ẩn”. Quét cần máy chủ hỗ trợ Fulcrum-RPA.',
    'experimental.rpaWarning':
      'Gửi tới Paycode cần signature grinding (chưa triển khai). Có thể nhận và quét.',
    'experimental.privacy': 'Riêng tư',
    'experimental.cashFusionDescription':
      'CashFusion là giao thức riêng tư không lưu ký, kết hợp UTXO của bạn với người khác để phá liên kết lịch sử giao dịch. Kết nối máy chủ CashFusion để tham gia. Tiền của bạn không gặp rủi ro — giao thức không cần tin cậy.',
    'experimental.cashFusionWarning':
      'Cần kết nối máy chủ CashFusion đang hoạt động. Sắp có — nút chuyển hiện được dành sẵn.',
    'p2p.title': 'Fusion P2P qua Nostr',
    'p2p.description':
      'Không cần máy chủ: các peer gặp nhau trên relay Nostr qua Tor, bầu điều phối viên xác định và chạy CoinJoin ngang hàng. Đầu ra không thể liên kết; bạn chỉ ký đầu vào của mình sau khi xác minh đầu ra.',
    'p2p.running': 'Đang chạy vòng P2P…',
    'p2p.start': 'Bắt đầu vòng P2P',
    'p2p.requiresPeers': 'Cần Tor và ít nhất 2 peer cùng nhóm.',
    'p2p.phase.announce': 'Thông báo và tìm peer',
    'p2p.phase.register': 'Đăng ký đầu vào và đầu ra',
    'p2p.phase.assemble': 'Lắp ráp và xác minh',
    'p2p.phase.sign': 'Đang ký',
    'p2p.phase.broadcast': 'Đang phát',
    'settingsPanels.contract': 'Thông tin hợp đồng',
    'settingsPanels.appLock': 'Khóa ứng dụng',
    'settingsPanels.server': 'Máy chủ',
    'settingsPanels.derivation': 'Đường dẫn dẫn xuất',
    'settingsPanels.console': 'Bảng điều khiển',
    'settingsPanels.experimental': 'Tính năng thử nghiệm',
    'settingsPanels.cashfusion': 'CashFusion',
    'settingsPanels.nostr': 'Nostr và trò chuyện',
    'settingsPanels.addons': 'Add-on',
    'settingsPanels.walletConnect': 'WalletConnect',
    'settingsPanels.wizardConnect': 'WizardConnect',
    'settingsPanels.faucet': 'Faucet Chipnet',
    'addons.installed': 'Add-on đã cài',
    'addons.description':
      'Add-on chạy trong frame sandbox, không truy cập khóa hoặc bộ nhớ ví — chỉ làm được những gì quyền bạn phê duyệt cho phép.',
    'addons.none': 'Chưa cài add-on.',
    'addons.uninstall': 'Gỡ cài đặt',
    'addons.installedStatus': 'Đã cài “{name}”. Khởi động lại ứng dụng để tải.',
    'addons.uninstalledStatus':
      'Đã gỡ. Khởi động lại ứng dụng để biến mất hoàn toàn.',
    'addons.installing': 'Đang cài…',
    'addons.installFolder': 'Cài từ thư mục…',
    'addons.desktopOnly': 'Chỉ có thể cài add-on từ thư mục trên máy tính.',
  },
  'zh-TW': {
    'desktopWallet.biometricUnlock': '生物辨識解鎖',
    'desktopWallet.alreadyOpen': '此錢包已在另一個視窗中開啟。',
    'desktopWallet.biometricFailed': '生物辨識解鎖失敗：{message}',
    'desktopWallet.incorrectFilePassword': '此錢包檔案的密碼不正確。',
    'desktopWallet.importFailed': '無法匯入此錢包檔案。',
    'desktopWallet.openFailed': '無法開啟此錢包。請再試一次。',
    'desktopWallet.hardwareTitle': '連線硬體錢包',
    'desktopWallet.device': '裝置',
    'desktopWallet.hardwareDescription':
      '連線時會自動用來簽署軟體錢包的傳送。尚不支援具有自己接收地址的純硬體錢包。',
    'desktopWallet.backToWallets': '返回錢包',
    'desktopWallet.openFile': '開啟「{name}」',
    'desktopWallet.filePasswordDescription': '輸入此錢包檔案的密碼。',
    'desktopWallet.password': '密碼',
    'desktopWallet.cancel': '取消',
    'desktopWallet.open': '開啟',
    'desktopWallet.opening': '開啟中…',
    'desktopWallet.yourWallets': '您的錢包',
    'desktopWallet.walletNumber': '錢包 #{id}',
    'desktopWallet.openButton': '開啟',
    'desktopWallet.deleteLabel': '刪除 {name}',
    'desktopWallet.deleteConfirm':
      '刪除「{name}」（{network}，#{id}）？已儲存的 .optn 檔案會保留，之後可以重新匯入。',
    'desktopWallet.delete': '刪除',
    'desktopWallet.deleting': '刪除中…',
    'desktopWallet.unlock': '解鎖',
    'desktopWallet.unlocking': '解鎖中…',
    'desktopWallet.useBiometric': '使用 {label}',
    'desktopWallet.addAnother': '新增另一個錢包',
    'settingsDerivation.description':
      'OPTN 一次支援一個作用中的 BIP44 帳戶路徑。重新設定會移除舊的衍生記錄，並重新探索與同步接收／找零地址。',
    'settingsDerivation.activePath': '作用中的 BIP44 帳戶路徑',
    'settingsDerivation.currentMode': '目前模式：{mode}。',
    'settingsDerivation.custom': '自訂',
    'settingsDerivation.networkDefault': '網路預設值',
    'settingsDerivation.invalidPath': '衍生路徑無效。',
    'settingsDerivation.alreadyActive': '此衍生路徑已作用中。',
    'settingsDerivation.confirm':
      '變更衍生路徑會清除目前地址、歷史與 UTXO 記錄。錢包之後只會重新產生並同步新路徑。要繼續嗎？',
    'settingsDerivation.completed': '衍生路徑已變更，錢包同步完成。',
    'settingsDerivation.failed': '錢包重新設定失敗。',
    'settingsDerivation.reconfiguring': '重新設定中…',
    'settingsDerivation.changeResync': '變更並重新同步',
    'settingsDerivation.useDefault': '使用網路預設值',
    'experimental.features': '實驗性功能',
    'experimental.description':
      '這些功能正在積極開發中。啟用它們以測試新能力；未來更新可能會變更或尚未完整。',
    'experimental.disable': '停用',
    'experimental.enable': '啟用',
    'experimental.quantumSafe': '量子安全',
    'experimental.quantumDescription':
      'Quantumroot 保管庫使用抗量子的 Schnorr LM-OTS 方案保護資金。預設啟用。不使用時可關閉以隱藏 Quantumroot。',
    'experimental.rpaTitle': '可重複使用的付款地址（RPA）',
    'experimental.rpaBadge': 'BCH RPA',
    'experimental.rpaDescription':
      '產生可公開分享的靜態 Paycode（paycode:q...）。寄件者透過 ECDH 為每筆付款導出唯一的一次性地址，不需通知交易，也不會增加鏈上負擔。收到的隱密資金會單獨顯示為「隱密 BCH」。掃描需要支援 Fulcrum-RPA 的伺服器。',
    'experimental.rpaWarning':
      '傳送至 Paycode 需要簽章 grinding（尚未實作）。接收與掃描可用。',
    'experimental.privacy': '隱私',
    'experimental.cashFusionDescription':
      'CashFusion 是非託管隱私協定，將您的 UTXO 與其他使用者的 UTXO 結合，以打破交易歷史連結。連線至 CashFusion 伺服器即可參與。資金不會承受風險，協定不需要信任。',
    'experimental.cashFusionWarning':
      '需要作用中的 CashFusion 伺服器連線。即將推出，目前保留此切換開關。',
    'p2p.title': '透過 Nostr 的 P2P Fusion',
    'p2p.description':
      '無需伺服器：節點透過 Tor 在 Nostr relays 上相遇，確定性選出協調者，並執行點對點 CoinJoin。輸出無法連結；確認自己的輸出後，只需簽署自己的輸入。',
    'p2p.running': '正在執行 P2P 回合…',
    'p2p.start': '開始 P2P 回合',
    'p2p.requiresPeers': '需要 Tor 以及同一層級至少 2 個節點。',
    'p2p.phase.announce': '公告並尋找節點',
    'p2p.phase.register': '註冊輸入與輸出',
    'p2p.phase.assemble': '組合並驗證',
    'p2p.phase.sign': '簽署中',
    'p2p.phase.broadcast': '廣播中',
    'settingsPanels.contract': '合約資訊',
    'settingsPanels.appLock': '應用程式鎖定',
    'settingsPanels.server': '伺服器',
    'settingsPanels.derivation': '衍生路徑',
    'settingsPanels.console': '主控台',
    'settingsPanels.experimental': '實驗性功能',
    'settingsPanels.cashfusion': 'CashFusion',
    'settingsPanels.nostr': 'Nostr 與聊天',
    'settingsPanels.addons': '附加元件',
    'settingsPanels.walletConnect': 'WalletConnect',
    'settingsPanels.wizardConnect': 'WizardConnect',
    'settingsPanels.faucet': 'Chipnet Faucet',
    'addons.installed': '已安裝的附加元件',
    'addons.description':
      '附加元件在沙盒框架中執行，無法存取錢包金鑰或記憶體，只能執行您核准的權限允許的操作。',
    'addons.none': '尚未安裝附加元件。',
    'addons.uninstall': '解除安裝',
    'addons.installedStatus': '已安裝「{name}」。重新啟動應用程式以載入。',
    'addons.uninstalledStatus': '已解除安裝。重新啟動應用程式以完全移除。',
    'addons.installing': '安裝中…',
    'addons.installFolder': '從資料夾安裝…',
    'addons.desktopOnly': '僅限在桌面從資料夾安裝附加元件。',
  },
  fr: {
    'desktopWallet.biometricUnlock': 'Déverrouillage biométrique',
    'desktopWallet.alreadyOpen':
      'Ce portefeuille est déjà ouvert dans une autre fenêtre.',
    'desktopWallet.biometricFailed':
      'Échec du déverrouillage biométrique : {message}',
    'desktopWallet.incorrectFilePassword':
      'Mot de passe incorrect pour ce fichier de portefeuille.',
    'desktopWallet.importFailed':
      'Impossible d’importer ce fichier de portefeuille.',
    'desktopWallet.openFailed':
      'Impossible d’ouvrir ce portefeuille. Réessayez.',
    'desktopWallet.hardwareTitle': 'Connecter un portefeuille matériel',
    'desktopWallet.device': 'Appareil',
    'desktopWallet.hardwareDescription':
      'Il servira automatiquement à signer les envois des portefeuilles logiciels lorsqu’il est connecté. Les portefeuilles matériel autonomes avec leurs propres adresses de réception ne sont pas encore pris en charge.',
    'desktopWallet.backToWallets': 'Retour aux portefeuilles',
    'desktopWallet.openFile': 'Ouvrir « {name} »',
    'desktopWallet.filePasswordDescription':
      'Saisissez le mot de passe de ce fichier de portefeuille.',
    'desktopWallet.password': 'Mot de passe',
    'desktopWallet.cancel': 'Annuler',
    'desktopWallet.open': 'Ouvrir',
    'desktopWallet.opening': 'Ouverture…',
    'desktopWallet.yourWallets': 'Vos portefeuilles',
    'desktopWallet.walletNumber': 'Portefeuille n° {id}',
    'desktopWallet.openButton': 'Ouvrir',
    'desktopWallet.deleteLabel': 'Supprimer {name}',
    'desktopWallet.deleteConfirm':
      'Supprimer « {name} » ({network}, n° {id}) ? Le fichier .optn enregistré est conservé pour permettre une réimportation.',
    'desktopWallet.delete': 'Supprimer',
    'desktopWallet.deleting': 'Suppression…',
    'desktopWallet.unlock': 'Déverrouiller',
    'desktopWallet.unlocking': 'Déverrouillage…',
    'desktopWallet.useBiometric': 'Utiliser {label}',
    'desktopWallet.addAnother': 'Ajouter un portefeuille',
    'settingsDerivation.description':
      'OPTN prend en charge un seul chemin de compte BIP44 actif à la fois. Sa reconfiguration supprime les anciens enregistrements dérivés et relance la découverte et la synchronisation des adresses de réception et de monnaie.',
    'settingsDerivation.activePath': 'Chemin de compte BIP44 actif',
    'settingsDerivation.currentMode': 'Mode actuel : {mode}.',
    'settingsDerivation.custom': 'personnalisé',
    'settingsDerivation.networkDefault': 'réseau par défaut',
    'settingsDerivation.invalidPath': 'Chemin de dérivation invalide.',
    'settingsDerivation.alreadyActive':
      'Ce chemin de dérivation est déjà actif.',
    'settingsDerivation.confirm':
      'Modifier le chemin efface les adresses, l’historique et les UTXO actuels. Le portefeuille régénérera et resynchronisera uniquement le nouveau chemin. Continuer ?',
    'settingsDerivation.completed':
      'Chemin modifié et resynchronisation terminée.',
    'settingsDerivation.failed': 'Échec de reconfiguration du portefeuille.',
    'settingsDerivation.reconfiguring': 'Reconfiguration…',
    'settingsDerivation.changeResync': 'Modifier et resynchroniser',
    'settingsDerivation.useDefault': 'Utiliser le réseau par défaut',
    'experimental.features': 'Fonctionnalités expérimentales',
    'experimental.description':
      'Ces fonctionnalités sont en cours de développement. Activez-les pour tester de nouvelles capacités ; elles peuvent changer ou rester incomplètes lors de futures mises à jour.',
    'experimental.disable': 'Désactiver',
    'experimental.enable': 'Activer',
    'experimental.quantumSafe': 'Résistant au quantique',
    'experimental.quantumDescription':
      'Les coffres Quantumroot protègent les fonds avec un schéma Schnorr LM-OTS résistant au quantique. Activé par défaut. Désactivez-le pour masquer Quantumroot si vous ne l’utilisez pas.',
    'experimental.rpaTitle': 'Adresses de paiement réutilisables (RPA)',
    'experimental.rpaBadge': 'BCH RPA',
    'experimental.rpaDescription':
      'Génère un Paycode statique (paycode:q...) partageable publiquement. Les expéditeurs dérivent une adresse unique par paiement via ECDH, sans transaction de notification ni surcharge de la chaîne. Les fonds furtifs reçus apparaissent séparément comme « BCH furtif ». Le scan nécessite un serveur compatible Fulcrum-RPA.',
    'experimental.rpaWarning':
      'L’envoi vers des Paycodes exige du signature grinding (non implémenté). La réception et le scan sont disponibles.',
    'experimental.privacy': 'Confidentialité',
    'experimental.cashFusionDescription':
      'CashFusion est un protocole de confidentialité non dépositaire qui combine vos UTXO avec ceux d’autres utilisateurs afin de rompre le lien de l’historique des transactions. Connectez-vous à un serveur CashFusion pour participer. Vos fonds ne sont jamais en danger : le protocole ne repose pas sur la confiance.',
    'experimental.cashFusionWarning':
      'Nécessite une connexion active à un serveur CashFusion. Bientôt disponible — ce bouton est réservé pour le moment.',
    'p2p.title': 'Fusion P2P via Nostr',
    'p2p.description':
      'Sans serveur : les pairs se rencontrent sur des relays Nostr via Tor, élisent un coordinateur déterministe et exécutent le CoinJoin en pair à pair. Les sorties sont impossibles à relier ; vous ne signez que vos propres entrées après avoir vérifié vos sorties.',
    'p2p.running': 'Exécution d’un tour P2P…',
    'p2p.start': 'Démarrer un tour P2P',
    'p2p.requiresPeers':
      'Nécessite Tor et au moins 2 pairs dans le même niveau.',
    'p2p.phase.announce': 'Annonce et recherche de pairs',
    'p2p.phase.register': 'Enregistrement des entrées et sorties',
    'p2p.phase.assemble': 'Assemblage et vérification',
    'p2p.phase.sign': 'Signature',
    'p2p.phase.broadcast': 'Diffusion',
    'settingsPanels.contract': 'Informations du contrat',
    'settingsPanels.appLock': 'Verrouillage de l’application',
    'settingsPanels.server': 'Serveur',
    'settingsPanels.derivation': 'Chemin de dérivation',
    'settingsPanels.console': 'Console',
    'settingsPanels.experimental': 'Fonctionnalités expérimentales',
    'settingsPanels.cashfusion': 'CashFusion',
    'settingsPanels.nostr': 'Nostr et chat',
    'settingsPanels.addons': 'Extensions',
    'settingsPanels.walletConnect': 'WalletConnect',
    'settingsPanels.wizardConnect': 'WizardConnect',
    'settingsPanels.faucet': 'Faucet Chipnet',
    'addons.installed': 'Extensions installées',
    'addons.description':
      'Les extensions s’exécutent dans un cadre isolé sans accès aux clés ni à la mémoire du portefeuille ; elles ne peuvent faire que ce que vos autorisations permettent.',
    'addons.none': 'Aucune extension installée.',
    'addons.uninstall': 'Désinstaller',
    'addons.installedStatus':
      '« {name} » installé. Redémarrez l’application pour le charger.',
    'addons.uninstalledStatus':
      'Désinstallé. Redémarrez l’application pour le supprimer complètement.',
    'addons.installing': 'Installation…',
    'addons.installFolder': 'Installer depuis un dossier…',
    'addons.desktopOnly':
      'L’installation d’extensions depuis un dossier est réservée à l’ordinateur.',
  },
  ko: {
    'desktopWallet.biometricUnlock': '생체 인증 잠금 해제',
    'desktopWallet.alreadyOpen': '이 지갑은 다른 창에서 이미 열려 있습니다.',
    'desktopWallet.biometricFailed': '생체 인증 잠금 해제 실패: {message}',
    'desktopWallet.incorrectFilePassword':
      '지갑 파일의 비밀번호가 올바르지 않습니다.',
    'desktopWallet.importFailed': '지갑 파일을 가져오지 못했습니다.',
    'desktopWallet.openFailed': '지갑을 열지 못했습니다. 다시 시도하세요.',
    'desktopWallet.hardwareTitle': '하드웨어 지갑 연결',
    'desktopWallet.device': '기기',
    'desktopWallet.hardwareDescription':
      '연결되어 있는 동안 소프트웨어 지갑의 전송에 자동으로 서명합니다. 자체 수신 주소가 있는 하드웨어 전용 지갑은 아직 지원되지 않습니다.',
    'desktopWallet.backToWallets': '지갑으로 돌아가기',
    'desktopWallet.openFile': '“{name}” 열기',
    'desktopWallet.filePasswordDescription':
      '이 지갑 파일의 비밀번호를 입력하세요.',
    'desktopWallet.password': '비밀번호',
    'desktopWallet.cancel': '취소',
    'desktopWallet.open': '열기',
    'desktopWallet.opening': '여는 중…',
    'desktopWallet.yourWallets': '내 지갑',
    'desktopWallet.walletNumber': '지갑 #{id}',
    'desktopWallet.openButton': '열기',
    'desktopWallet.deleteLabel': '{name} 삭제',
    'desktopWallet.deleteConfirm':
      '“{name}”( {network}, #{id})을(를) 삭제할까요? 저장된 .optn 파일은 유지되므로 나중에 다시 가져올 수 있습니다.',
    'desktopWallet.delete': '삭제',
    'desktopWallet.deleting': '삭제 중…',
    'desktopWallet.unlock': '잠금 해제',
    'desktopWallet.unlocking': '잠금 해제 중…',
    'desktopWallet.useBiometric': '{label} 사용',
    'desktopWallet.addAnother': '다른 지갑 추가',
    'settingsDerivation.description':
      'OPTN은 한 번에 하나의 활성 BIP44 계정 경로를 지원합니다. 다시 구성하면 이전 파생 기록을 제거하고 수신/잔돈 검색과 동기화를 새로 수행합니다.',
    'settingsDerivation.activePath': '활성 BIP44 계정 경로',
    'settingsDerivation.currentMode': '현재 모드: {mode}.',
    'settingsDerivation.custom': '맞춤',
    'settingsDerivation.networkDefault': '네트워크 기본값',
    'settingsDerivation.invalidPath': '잘못된 파생 경로입니다.',
    'settingsDerivation.alreadyActive':
      '이 파생 경로는 이미 활성화되어 있습니다.',
    'settingsDerivation.confirm':
      '파생 경로를 변경하면 현재 주소, 기록 및 UTXO가 삭제됩니다. 지갑은 새 경로만 다시 생성하고 동기화합니다. 계속할까요?',
    'settingsDerivation.completed':
      '파생 경로를 변경하고 지갑 동기화를 완료했습니다.',
    'settingsDerivation.failed': '지갑 재구성 실패',
    'settingsDerivation.reconfiguring': '재구성 중…',
    'settingsDerivation.changeResync': '변경하고 다시 동기화',
    'settingsDerivation.useDefault': '네트워크 기본값 사용',
    'experimental.features': '실험적 기능',
    'experimental.description':
      '이 기능은 활발히 개발 중입니다. 새 기능을 테스트하려면 활성화하세요. 향후 업데이트에서 변경되거나 미완성일 수 있습니다.',
    'experimental.disable': '비활성화',
    'experimental.enable': '활성화',
    'experimental.quantumSafe': '양자 안전',
    'experimental.quantumDescription':
      'Quantumroot 볼트는 양자 내성 Schnorr LM-OTS 방식으로 자금을 보호합니다. 기본으로 활성화됩니다. 사용하지 않으면 끄고 Quantumroot를 숨길 수 있습니다.',
    'experimental.rpaTitle': '재사용 가능한 결제 주소(RPA)',
    'experimental.rpaBadge': 'BCH RPA',
    'experimental.rpaDescription':
      '공개적으로 공유할 수 있는 정적 Paycode(paycode:q...)를 생성합니다. 송금자는 ECDH로 결제마다 고유한 일회성 주소를 파생합니다. 알림 트랜잭션이나 체인 부풀림이 없습니다. 받은 스텔스 자금은 “스텔스 BCH”로 따로 표시됩니다. 스캔에는 Fulcrum-RPA 서버가 필요합니다.',
    'experimental.rpaWarning':
      'Paycode로 보내려면 서명 grinding이 필요하며 아직 구현되지 않았습니다. 수신과 스캔은 사용할 수 있습니다.',
    'experimental.privacy': '개인정보 보호',
    'experimental.cashFusionDescription':
      'CashFusion은 다른 사용자의 UTXO와 내 UTXO를 결합해 거래 기록의 연결을 끊는 비수탁 개인정보 프로토콜입니다. 참여하려면 CashFusion 서버에 연결하세요. 프로토콜은 신뢰가 필요 없으므로 자금은 위험하지 않습니다.',
    'experimental.cashFusionWarning':
      '활성 CashFusion 서버 연결이 필요합니다. 곧 제공되며 현재 토글은 예약 상태입니다.',
    'p2p.title': 'Nostr를 통한 P2P Fusion',
    'p2p.description':
      '서버 없이 피어가 Tor를 통해 Nostr 릴레이에서 만나 결정론적으로 코디네이터를 선택하고 P2P CoinJoin을 실행합니다. 출력은 연결할 수 없으며, 내 출력을 확인한 뒤 내 입력만 서명합니다.',
    'p2p.running': 'P2P 라운드 실행 중…',
    'p2p.start': 'P2P 라운드 시작',
    'p2p.requiresPeers': 'Tor와 같은 티어의 피어 2개 이상이 필요합니다.',
    'p2p.phase.announce': '알리고 피어 찾기',
    'p2p.phase.register': '입력 및 출력 등록',
    'p2p.phase.assemble': '구성 및 확인',
    'p2p.phase.sign': '서명 중',
    'p2p.phase.broadcast': '브로드캐스트 중',
    'settingsPanels.contract': '컨트랙트 정보',
    'settingsPanels.appLock': '앱 잠금',
    'settingsPanels.server': '서버',
    'settingsPanels.derivation': '파생 경로',
    'settingsPanels.console': '콘솔',
    'settingsPanels.experimental': '실험적 기능',
    'settingsPanels.cashfusion': 'CashFusion',
    'settingsPanels.nostr': 'Nostr 및 채팅',
    'settingsPanels.addons': '애드온',
    'settingsPanels.walletConnect': 'WalletConnect',
    'settingsPanels.wizardConnect': 'WizardConnect',
    'settingsPanels.faucet': 'Chipnet Faucet',
    'addons.installed': '설치된 애드온',
    'addons.description':
      '애드온은 지갑 키나 메모리에 접근할 수 없는 샌드박스 프레임에서 실행되며 승인한 권한만 사용할 수 있습니다.',
    'addons.none': '설치된 애드온이 없습니다.',
    'addons.uninstall': '제거',
    'addons.installedStatus':
      '“{name}”을(를) 설치했습니다. 로드하려면 앱을 다시 시작하세요.',
    'addons.uninstalledStatus':
      '제거했습니다. 완전히 사라지게 하려면 앱을 다시 시작하세요.',
    'addons.installing': '설치 중…',
    'addons.installFolder': '폴더에서 설치…',
    'addons.desktopOnly':
      '폴더에서 애드온을 설치하는 기능은 데스크톱에서만 사용할 수 있습니다.',
  },
  ja: {
    'desktopWallet.biometricUnlock': '生体認証でロック解除',
    'desktopWallet.alreadyOpen':
      'このウォレットは別のウィンドウですでに開いています。',
    'desktopWallet.biometricFailed':
      '生体認証のロック解除に失敗しました：{message}',
    'desktopWallet.incorrectFilePassword':
      'このウォレットファイルのパスワードが正しくありません。',
    'desktopWallet.importFailed':
      'このウォレットファイルをインポートできませんでした。',
    'desktopWallet.openFailed':
      'ウォレットを開けませんでした。もう一度お試しください。',
    'desktopWallet.hardwareTitle': 'ハードウェアウォレットを接続',
    'desktopWallet.device': 'デバイス',
    'desktopWallet.hardwareDescription':
      '接続中はソフトウェアウォレットの送信に自動的に署名します。独自の受取アドレスを持つハードウェア専用ウォレットはまだサポートされていません。',
    'desktopWallet.backToWallets': 'ウォレットに戻る',
    'desktopWallet.openFile': '「{name}」を開く',
    'desktopWallet.filePasswordDescription':
      'このウォレットファイルのパスワードを入力してください。',
    'desktopWallet.password': 'パスワード',
    'desktopWallet.cancel': 'キャンセル',
    'desktopWallet.open': '開く',
    'desktopWallet.opening': '開いています…',
    'desktopWallet.yourWallets': '自分のウォレット',
    'desktopWallet.walletNumber': 'ウォレット #{id}',
    'desktopWallet.openButton': '開く',
    'desktopWallet.deleteLabel': '{name} を削除',
    'desktopWallet.deleteConfirm':
      '「{name}」（{network}、#{id}）を削除しますか？保存済みの .optn ファイルは残るため、後で再インポートできます。',
    'desktopWallet.delete': '削除',
    'desktopWallet.deleting': '削除中…',
    'desktopWallet.unlock': 'ロック解除',
    'desktopWallet.unlocking': 'ロック解除中…',
    'desktopWallet.useBiometric': '{label} を使用',
    'desktopWallet.addAnother': '別のウォレットを追加',
    'settingsDerivation.description':
      'OPTN は一度に 1 つの BIP44 アカウントパスを有効にできます。再構成すると古い導出記録を削除し、受取とおつりの検出および同期をやり直します。',
    'settingsDerivation.activePath': 'アクティブな BIP44 アカウントパス',
    'settingsDerivation.currentMode': '現在のモード：{mode}。',
    'settingsDerivation.custom': 'カスタム',
    'settingsDerivation.networkDefault': 'ネットワークの既定値',
    'settingsDerivation.invalidPath': '導出パスが無効です。',
    'settingsDerivation.alreadyActive': 'この導出パスはすでに有効です。',
    'settingsDerivation.confirm':
      '導出パスを変更すると、現在のアドレス、履歴、UTXO が消去されます。その後、新しいパスだけを再生成して同期します。続けますか？',
    'settingsDerivation.completed':
      '導出パスを変更し、ウォレットの同期が完了しました。',
    'settingsDerivation.failed': 'ウォレットの再構成に失敗しました。',
    'settingsDerivation.reconfiguring': '再構成中…',
    'settingsDerivation.changeResync': '変更して再同期',
    'settingsDerivation.useDefault': 'ネットワークの既定値を使用',
    'experimental.features': '実験的な機能',
    'experimental.description':
      'これらの機能は開発中です。有効にすると新しい機能を試せますが、今後の更新で変更または未完成のままになる場合があります。',
    'experimental.disable': '無効化',
    'experimental.enable': '有効化',
    'experimental.quantumSafe': '量子安全',
    'experimental.quantumDescription':
      'Quantumroot 保管庫は量子耐性のある Schnorr LM-OTS 方式で資金を保護します。既定で有効です。使用しない場合は無効にして Quantumroot を隠せます。',
    'experimental.rpaTitle': '再利用可能な支払いアドレス（RPA）',
    'experimental.rpaBadge': 'BCH RPA',
    'experimental.rpaDescription':
      '公開共有できる静的 Paycode（paycode:q...）を生成します。送信者は ECDH で支払いごとの固有の使い捨てアドレスを導出します。通知トランザクションもチェーンの肥大化もありません。受け取ったステルス資金は「ステルス BCH」として別に表示されます。スキャンには Fulcrum-RPA 対応サーバーが必要です。',
    'experimental.rpaWarning':
      'Paycode への送信には署名 grinding が必要ですが、まだ実装されていません。受取とスキャンは利用できます。',
    'experimental.privacy': 'プライバシー',
    'experimental.cashFusionDescription':
      'CashFusion は、他のユーザーの UTXO と組み合わせて取引履歴のリンクを切る非カストディアルなプライバシープロトコルです。参加するには CashFusion サーバーに接続します。信頼不要のプロトコルなので資金が危険にさらされることはありません。',
    'experimental.cashFusionWarning':
      '有効な CashFusion サーバー接続が必要です。近日公開で、現在このトグルは予約されています。',
    'p2p.title': 'Nostr 上の P2P Fusion',
    'p2p.description':
      'サーバーなしで、ピアが Tor 経由で Nostr relay に集まり、決定論的にコーディネーターを選び、P2P CoinJoin を実行します。出力はリンクできず、自分の出力を確認した後に自分の入力だけに署名します。',
    'p2p.running': 'P2P ラウンドを実行中…',
    'p2p.start': 'P2P ラウンドを開始',
    'p2p.requiresPeers': 'Tor と同じティアの 2 ピア以上が必要です。',
    'p2p.phase.announce': '通知してピアを検索',
    'p2p.phase.register': '入力と出力を登録',
    'p2p.phase.assemble': '組み立てて検証',
    'p2p.phase.sign': '署名中',
    'p2p.phase.broadcast': 'ブロードキャスト中',
    'settingsPanels.contract': 'コントラクト情報',
    'settingsPanels.appLock': 'アプリロック',
    'settingsPanels.server': 'サーバー',
    'settingsPanels.derivation': '導出パス',
    'settingsPanels.console': 'コンソール',
    'settingsPanels.experimental': '実験的な機能',
    'settingsPanels.cashfusion': 'CashFusion',
    'settingsPanels.nostr': 'Nostr とチャット',
    'settingsPanels.addons': 'アドオン',
    'settingsPanels.walletConnect': 'WalletConnect',
    'settingsPanels.wizardConnect': 'WizardConnect',
    'settingsPanels.faucet': 'Chipnet Faucet',
    'addons.installed': 'インストール済みアドオン',
    'addons.description':
      'アドオンはウォレットのキーやメモリにアクセスできないサンドボックスフレームで実行され、承認した権限の範囲でのみ動作します。',
    'addons.none': 'インストール済みアドオンはありません。',
    'addons.uninstall': 'アンインストール',
    'addons.installedStatus':
      '「{name}」をインストールしました。読み込むにはアプリを再起動してください。',
    'addons.uninstalledStatus':
      'アンインストールしました。完全に消すにはアプリを再起動してください。',
    'addons.installing': 'インストール中…',
    'addons.installFolder': 'フォルダーからインストール…',
    'addons.desktopOnly':
      'フォルダーからのアドオンインストールはデスクトップでのみ利用できます。',
  },
  ru: {
    'desktopWallet.biometricUnlock': 'Биометрическая разблокировка',
    'desktopWallet.alreadyOpen': 'Этот кошелёк уже открыт в другом окне.',
    'desktopWallet.biometricFailed':
      'Не удалось разблокировать биометрией: {message}',
    'desktopWallet.incorrectFilePassword':
      'Неверный пароль для файла кошелька.',
    'desktopWallet.importFailed': 'Не удалось импортировать файл кошелька.',
    'desktopWallet.openFailed':
      'Не удалось открыть кошелёк. Повторите попытку.',
    'desktopWallet.hardwareTitle': 'Подключить аппаратный кошелёк',
    'desktopWallet.device': 'Устройство',
    'desktopWallet.hardwareDescription':
      'При подключении он будет автоматически подписывать отправку из программных кошельков. Отдельные аппаратные кошельки со своими адресами получения пока не поддерживаются.',
    'desktopWallet.backToWallets': 'Назад к кошелькам',
    'desktopWallet.openFile': 'Открыть «{name}»',
    'desktopWallet.filePasswordDescription': 'Введите пароль файла кошелька.',
    'desktopWallet.password': 'Пароль',
    'desktopWallet.cancel': 'Отмена',
    'desktopWallet.open': 'Открыть',
    'desktopWallet.opening': 'Открытие…',
    'desktopWallet.yourWallets': 'Ваши кошельки',
    'desktopWallet.walletNumber': 'Кошелёк №{id}',
    'desktopWallet.openButton': 'Открыть',
    'desktopWallet.deleteLabel': 'Удалить {name}',
    'desktopWallet.deleteConfirm':
      'Удалить «{name}» ({network}, №{id})? Сохранённый файл .optn останется, и его можно будет импортировать снова.',
    'desktopWallet.delete': 'Удалить',
    'desktopWallet.deleting': 'Удаление…',
    'desktopWallet.unlock': 'Разблокировать',
    'desktopWallet.unlocking': 'Разблокировка…',
    'desktopWallet.useBiometric': 'Использовать {label}',
    'desktopWallet.addAnother': 'Добавить кошелёк',
    'settingsDerivation.description':
      'OPTN поддерживает один активный путь аккаунта BIP44. Перенастройка удаляет старые записи деривации и заново выполняет поиск и синхронизацию адресов получения и сдачи.',
    'settingsDerivation.activePath': 'Активный путь аккаунта BIP44',
    'settingsDerivation.currentMode': 'Текущий режим: {mode}.',
    'settingsDerivation.custom': 'пользовательский',
    'settingsDerivation.networkDefault': 'сеть по умолчанию',
    'settingsDerivation.invalidPath': 'Недействительный путь деривации.',
    'settingsDerivation.alreadyActive': 'Этот путь деривации уже активен.',
    'settingsDerivation.confirm':
      'Изменение пути очистит текущие адреса, историю и UTXO. Кошелёк создаст и синхронизирует только новый путь. Продолжить?',
    'settingsDerivation.completed':
      'Путь изменён, синхронизация кошелька завершена.',
    'settingsDerivation.failed': 'Не удалось перенастроить кошелёк.',
    'settingsDerivation.reconfiguring': 'Перенастройка…',
    'settingsDerivation.changeResync': 'Изменить и синхронизировать',
    'settingsDerivation.useDefault': 'Использовать сеть по умолчанию',
    'experimental.features': 'Экспериментальные функции',
    'experimental.description':
      'Эти функции активно разрабатываются. Включите их для проверки новых возможностей; в будущих обновлениях они могут измениться или остаться незавершёнными.',
    'experimental.disable': 'Отключить',
    'experimental.enable': 'Включить',
    'experimental.quantumSafe': 'Квантово-безопасный',
    'experimental.quantumDescription':
      'Хранилища Quantumroot защищают средства квантово-устойчивой схемой Schnorr LM-OTS. Включено по умолчанию. Отключите, чтобы скрыть Quantumroot, если не используете его.',
    'experimental.rpaTitle': 'Повторно используемые платёжные адреса (RPA)',
    'experimental.rpaBadge': 'BCH RPA',
    'experimental.rpaDescription':
      'Создаёт статический Paycode (paycode:q...), которым можно делиться публично. Отправители выводят уникальный одноразовый адрес для каждого платежа через ECDH — без транзакции уведомления и раздувания цепочки. Полученные скрытые средства отображаются отдельно как «Скрытый BCH». Для сканирования нужен сервер Fulcrum-RPA.',
    'experimental.rpaWarning':
      'Отправка на Paycode требует signature grinding (ещё не реализовано). Получение и сканирование доступны.',
    'experimental.privacy': 'Конфиденциальность',
    'experimental.cashFusionDescription':
      'CashFusion — некастодиальный протокол конфиденциальности, который объединяет ваши UTXO с UTXO других пользователей и разрывает связи истории транзакций. Подключитесь к серверу CashFusion для участия. Средства не подвергаются риску: протокол не требует доверия.',
    'experimental.cashFusionWarning':
      'Требуется активное подключение к серверу CashFusion. Скоро; переключатель пока зарезервирован.',
    'p2p.title': 'P2P Fusion через Nostr',
    'p2p.description':
      'Без сервера: пиры встречаются в relays Nostr через Tor, детерминированно выбирают координатора и выполняют CoinJoin между собой. Выходы невозможно связать; после проверки своих выходов вы подписываете только свои входы.',
    'p2p.running': 'Выполняется раунд P2P…',
    'p2p.start': 'Начать раунд P2P',
    'p2p.requiresPeers': 'Требуются Tor и как минимум 2 пира в одном уровне.',
    'p2p.phase.announce': 'Объявление и поиск пиров',
    'p2p.phase.register': 'Регистрация входов и выходов',
    'p2p.phase.assemble': 'Сборка и проверка',
    'p2p.phase.sign': 'Подписание',
    'p2p.phase.broadcast': 'Трансляция',
    'settingsPanels.contract': 'Сведения о контракте',
    'settingsPanels.appLock': 'Блокировка приложения',
    'settingsPanels.server': 'Сервер',
    'settingsPanels.derivation': 'Путь деривации',
    'settingsPanels.console': 'Консоль',
    'settingsPanels.experimental': 'Экспериментальные функции',
    'settingsPanels.cashfusion': 'CashFusion',
    'settingsPanels.nostr': 'Nostr и чат',
    'settingsPanels.addons': 'Дополнения',
    'settingsPanels.walletConnect': 'WalletConnect',
    'settingsPanels.wizardConnect': 'WizardConnect',
    'settingsPanels.faucet': 'Faucet Chipnet',
    'addons.installed': 'Установленные дополнения',
    'addons.description':
      'Дополнения работают в изолированном фрейме без доступа к ключам или памяти кошелька и могут делать только разрешённое вами.',
    'addons.none': 'Дополнения не установлены.',
    'addons.uninstall': 'Удалить',
    'addons.installedStatus':
      '«{name}» установлено. Перезапустите приложение для загрузки.',
    'addons.uninstalledStatus':
      'Удалено. Перезапустите приложение, чтобы оно исчезло полностью.',
    'addons.installing': 'Установка…',
    'addons.installFolder': 'Установить из папки…',
    'addons.desktopOnly':
      'Установка дополнений из папки доступна только на компьютере.',
  },
  'ha-NG': {
    'desktopWallet.biometricUnlock': 'Buɗewar biometric',
    'desktopWallet.alreadyOpen': 'An riga an buɗe wannan wallet a wata taga.',
    'desktopWallet.biometricFailed': 'Buɗewar biometric ta gaza: {message}',
    'desktopWallet.incorrectFilePassword':
      'Kalmar sirrin wannan fayil ɗin wallet ba daidai ba ce.',
    'desktopWallet.importFailed': 'An kasa shigo da wannan fayil ɗin wallet.',
    'desktopWallet.openFailed': 'An kasa buɗe wannan wallet. Sake gwadawa.',
    'desktopWallet.hardwareTitle': 'Haɗa hardware wallet',
    'desktopWallet.device': 'Na’ura',
    'desktopWallet.hardwareDescription':
      'Za a yi amfani da ita kai tsaye wajen sa hannu kan aikawa daga software wallets idan an haɗa ta. Hardware-only wallets masu adireshin karɓa nasu ba su goyan baya tukuna.',
    'desktopWallet.backToWallets': 'Koma wallets',
    'desktopWallet.openFile': 'Buɗe “{name}”',
    'desktopWallet.filePasswordDescription':
      'Shigar da kalmar sirrin wannan fayil ɗin wallet.',
    'desktopWallet.password': 'Kalmar sirri',
    'desktopWallet.cancel': 'Soke',
    'desktopWallet.open': 'Buɗe',
    'desktopWallet.opening': 'Ana buɗewa…',
    'desktopWallet.yourWallets': 'Wallets ɗinka',
    'desktopWallet.walletNumber': 'Wallet #{id}',
    'desktopWallet.openButton': 'Buɗe',
    'desktopWallet.deleteLabel': 'Share {name}',
    'desktopWallet.deleteConfirm':
      'Share “{name}” ({network}, #{id})? Za a riƙe fayil ɗin .optn da aka ajiye domin ka sake shigo da shi daga baya.',
    'desktopWallet.delete': 'Share',
    'desktopWallet.deleting': 'Ana sharewa…',
    'desktopWallet.unlock': 'Buɗe kulle',
    'desktopWallet.unlocking': 'Ana buɗe kulle…',
    'desktopWallet.useBiometric': 'Yi amfani da {label}',
    'desktopWallet.addAnother': 'Ƙara wani wallet',
    'settingsDerivation.description':
      'OPTN tana goyan bayan hanyar account ta BIP44 guda ɗaya mai aiki a lokaci guda. Sake tsara ta yana cire tsoffin bayanan derivation kuma ya sake gano adireshin karɓa/canji ya daidaita.',
    'settingsDerivation.activePath': 'Hanyar account ta BIP44 mai aiki',
    'settingsDerivation.currentMode': 'Yanayin yanzu: {mode}.',
    'settingsDerivation.custom': 'na musamman',
    'settingsDerivation.networkDefault': 'tsohuwar hanyar sadarwa',
    'settingsDerivation.invalidPath': 'Hanyar derivation ba daidai ba ce.',
    'settingsDerivation.alreadyActive':
      'Wannan hanyar derivation tana aiki tuni.',
    'settingsDerivation.confirm':
      'Canja hanyar derivation zai share adireshi, tarihi da UTXO na yanzu. Wallet zai sake ƙirƙira da daidaita sabuwar hanya kawai. A ci gaba?',
    'settingsDerivation.completed':
      'An canja hanyar derivation kuma an kammala daidaita wallet.',
    'settingsDerivation.failed': 'Sake tsara wallet ya gaza.',
    'settingsDerivation.reconfiguring': 'Ana sake tsarawa…',
    'settingsDerivation.changeResync': 'Canja kuma sake daidaitawa',
    'settingsDerivation.useDefault': 'Yi amfani da tsohuwar hanyar sadarwa',
    'experimental.features': 'Fasalolin gwaji',
    'experimental.description':
      'Ana ci gaba da haɓaka waɗannan fasaloli. Kunna su don gwada sabbin iko — za su iya canja ko su kasance ba su cika ba a sabuntawa na gaba.',
    'experimental.disable': 'Kashe',
    'experimental.enable': 'Kunna',
    'experimental.quantumSafe': 'Amintacce ga quantum',
    'experimental.quantumDescription':
      'Quantumroot vaults suna kare kuɗi da tsarin Schnorr LM-OTS mai jure quantum. A kunne ta tsohuwa. Kashe don ɓoye Quantumroot idan ba ka amfani da shi.',
    'experimental.rpaTitle': 'Adireshin biyan kuɗi da za a sake amfani (RPA)',
    'experimental.rpaBadge': 'BCH RPA',
    'experimental.rpaDescription':
      'Yana ƙirƙirar Paycode na dindindin (paycode:q...) da za ka iya raba a fili. Masu aikawa suna samo adireshi na sau ɗaya na musamman ga kowane biyan kuɗi ta ECDH — babu cinikin sanarwa ko kumburin sarka. Kuɗin ɓoye da aka karɓa suna bayyana daban a matsayin “BCH na ɓoye”. Dubawa na buƙatar server mai Fulcrum-RPA.',
    'experimental.rpaWarning':
      'Aika zuwa Paycode yana buƙatar signature grinding (ba a aiwatar ba tukuna). Karɓa da dubawa suna samuwa.',
    'experimental.privacy': 'Sirri',
    'experimental.cashFusionDescription':
      'CashFusion yarjejeniya ce ta sirri marar riƙon kuɗi wadda ke haɗa UTXO ɗinka da na wasu don karya alaƙar tarihin ciniki. Haɗa CashFusion server don shiga. Kuɗinka ba sa cikin haɗari — yarjejeniyar ba ta buƙatar amincewa.',
    'experimental.cashFusionWarning':
      'Ana buƙatar haɗin CashFusion server mai aiki. Zai zo nan gaba — an ajiye wannan sauyawa a yanzu.',
    'p2p.title': 'Fusion P2P ta Nostr',
    'p2p.description':
      'Babu server: peers suna haɗuwa a Nostr relays ta Tor, suna zaɓar coordinator mai ƙaddara, sannan su gudanar da CoinJoin tsakanin juna. Ba za a iya haɗa fitarwa ba; kana sa hannu kan abubuwan shigarwarka kawai bayan ka tabbatar da fitarwarka.',
    'p2p.running': 'Ana gudanar da zagayen P2P…',
    'p2p.start': 'Fara zagayen P2P',
    'p2p.requiresPeers': 'Yana buƙatar Tor da peers aƙalla 2 a rukuni ɗaya.',
    'p2p.phase.announce': 'Sanarwa da neman peers',
    'p2p.phase.register': 'Rijistar shigarwa da fitarwa',
    'p2p.phase.assemble': 'Haɗawa da tabbatarwa',
    'p2p.phase.sign': 'Sa hannu',
    'p2p.phase.broadcast': 'Watsawa',
    'settingsPanels.contract': 'Bayanan kwangila',
    'settingsPanels.appLock': 'Kulle manhaja',
    'settingsPanels.server': 'Server',
    'settingsPanels.derivation': 'Hanyar derivation',
    'settingsPanels.console': 'Console',
    'settingsPanels.experimental': 'Fasalolin gwaji',
    'settingsPanels.cashfusion': 'CashFusion',
    'settingsPanels.nostr': 'Nostr da hira',
    'settingsPanels.addons': 'Add-ons',
    'settingsPanels.walletConnect': 'WalletConnect',
    'settingsPanels.wizardConnect': 'WizardConnect',
    'settingsPanels.faucet': 'Chipnet Faucet',
    'addons.installed': 'Add-ons da aka girka',
    'addons.description':
      'Add-ons suna aiki a frame mai sandbox ba tare da damar maɓallan ko ƙwaƙwalwar wallet ba — suna yin abin da izinin da ka amince da shi kawai.',
    'addons.none': 'Babu add-on da aka girka.',
    'addons.uninstall': 'Cire girka',
    'addons.installedStatus':
      'An girka “{name}”. Sake kunna manhaja don lodawa.',
    'addons.uninstalledStatus':
      'An cire girka. Sake kunna manhaja don ya ɓace gaba ɗaya.',
    'addons.installing': 'Ana girkawa…',
    'addons.installFolder': 'Girka daga babban fayil…',
    'addons.desktopOnly':
      'Girka add-ons daga babban fayil yana samuwa a kwamfuta kawai.',
  },
};

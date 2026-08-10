import type { BaseLocale, SupportedLocale } from './types';

type AddedLocale = Exclude<SupportedLocale, BaseLocale>;

/** Contract UI is wallet-owned; contract names and protocol identifiers stay stable. */
export const localeContractOverrides: Partial<
  Record<AddedLocale, Record<string, string>>
> = {
  'pt-BR': {
    'contractView.title': 'Contratos',
    'contractView.create': 'Criar contrato',
    'contractView.howWorks': 'Como funciona',
    'contractView.pickTemplate': '1. Escolha um modelo',
    'contractView.fillInputs': '2. Preencha as entradas do construtor',
    'contractView.createStep': '3. Crie o contrato',
    'contractView.selectContract': 'Selecione um contrato',
    'contractView.instantiated': 'Contratos instanciados',
    'contractView.address': 'Endereço',
    'contractView.tokenAddress': 'Endereço do token',
    'contractView.balance': 'Saldo',
    'contractView.noInstances': 'Ainda não há instâncias de contrato.',
    'contractView.delete': 'Excluir',
    'contractView.update': 'Atualizar',
    'contractView.back': 'Voltar',
    'contractView.constructorArgs': 'Argumentos do construtor',
    'contractView.fillRequired':
      'Preencha cada valor obrigatório antes de criar o contrato.',
    'contractView.blockHeight': 'Altura atual do bloco',
    'contractView.blockHeightInfo':
      'Os blocos avançam em um intervalo médio de 10 minutos.',
    'contractView.unavailable': 'Indisponível',
    'contractView.noInputs':
      'Este modelo de contrato não tem entradas do construtor.',
    'contractView.datasigInfo': 'Informações da assinatura de dados',
    'contractView.enterMessage': 'Digite a mensagem para {name}',
    'contractView.selectAddress': 'Selecionar endereço',
    'contractView.scanQr': 'Escanear código QR para {name}',
    'contractView.signMessage': 'Assinar mensagem',
    'contractView.signingAddress': 'Endereço de assinatura',
    'contractView.signature': 'Assinatura',
    'contractView.argumentTypeInfo': 'Informações do tipo do argumento',
    'contractView.publicKeyInfo':
      'Chave pública em hexadecimal. Use “Selecionar endereço” para preencher automaticamente.',
    'contractView.hashInfo':
      'Hash de 20 bytes (hexadecimal) de um endereço ou chave pública. Use “Selecionar endereço”.',
    'contractView.enterType': 'Digite um valor compatível com o tipo: {type}.',
    'contractView.selected': '{type} selecionado',
    'contractView.error': 'Erro',
    'contractView.addressCopied':
      'Endereço copiado para a área de transferência!',
    'contractView.copyFailed': 'Falha ao copiar o endereço.',
    'contractView.selectData':
      'Selecione um endereço e digite os dados para assinar.',
    'contractView.signatureGenerated': 'Assinatura gerada com sucesso!',
    'contractView.signatureFailed': 'Falha ao gerar a assinatura.',
    'contractView.noQr': 'Nenhum código QR detectado. Tente novamente.',
    'contractView.created': 'Contrato criado com sucesso!',
    'contractView.deleted': 'Contrato excluído com sucesso!',
    'contractView.deleteFailed': 'Falha ao excluir o contrato.',
    'contractView.updated': 'Contrato atualizado com sucesso!',
    'contractView.updateFailed': 'Falha ao atualizar o contrato.',
    'contractView.loadContractsFailed':
      'Falha ao carregar os contratos disponíveis.',
    'contractView.loadInstancesFailed':
      'Falha ao carregar as instâncias de contrato.',
    'contractView.loadDetailsFailed':
      'Falha ao carregar os detalhes do contrato.',
    'contractView.createFailed': 'Falha ao criar o contrato: {message}',
    'contractView.deleteFailedFallback': 'Falha ao excluir o contrato.',
    'contractView.updateFailedFallback': 'Falha ao atualizar o contrato.',
    'contractView.unknownError': 'Erro desconhecido',
    'contractView.privateKeyUnavailable':
      'Chave privada indisponível para este endereço.',
    'contractView.errorPrefix': 'Erro: {message}',
    'contract.intro':
      'Os contratos covenant da OPTN Wallet são contratos inteligentes que impõem regras para gastar ativos digitais. Cada contrato bloqueia fundos em UTXOs que só podem ser gastos quando condições predefinidas são atendidas.',
    'contract.available': 'Contratos disponíveis',
    'contract.bip38': 'BIP38 (chaves privadas protegidas por senha)',
    'contract.bip38Desc':
      'O contrato BIP38 protege chaves privadas com uma senha. Seus UTXOs exigem a senha correta e uma assinatura válida.',
    'contract.passwordProtection':
      'Proteção por senha: criptografa sua chave privada com uma senha definida pelo usuário.',
    'contract.bip38Spending':
      'Requisitos de gasto: forneça uma assinatura válida do proprietário e uma assinatura de dados que confirme a senha.',
    'contract.bip38UseCase':
      'Uso: ideal para proteger chaves privadas contra roubo ou acesso não autorizado, especialmente em armazenamento de longo prazo.',
    'contract.escrow': 'Escrow',
    'contract.escrowDesc':
      'O contrato Escrow permite transações seguras entre comprador e vendedor com um árbitro confiável. Os fundos só são liberados com a aprovação do árbitro.',
    'contract.arbiter':
      'Árbitro: parte confiável que autoriza a liberação dos fundos.',
    'contract.escrowSpending':
      'Requisitos de gasto: o árbitro fornece uma assinatura válida e o valor total vai para o endereço de hash da chave pública do comprador ou vendedor.',
    'contract.escrowSecurity':
      'Segurança: os fundos permanecem bloqueados até a aprovação do árbitro, ajudando a evitar fraude ou disputas.',
    'contract.escrowMS2': 'EscrowMS2 (escrow multipartes)',
    'contract.escrowMS2Desc':
      'O EscrowMS2 amplia o escrow com dois árbitros. Os fundos podem ser liberados com a aprovação de um árbitro ou com a aprovação conjunta dos dois.',
    'contract.multipleArbiters':
      'Vários árbitros: dois árbitros podem autorizar a liberação dos fundos.',
    'contract.escrowMS2Spending':
      'Requisitos de gasto: um ou ambos os árbitros fornecem assinaturas válidas, e o valor total vai para o comprador ou vendedor.',
    'contract.enhancedTrust':
      'Confiança reforçada: útil para transações que exigem várias partes confiáveis.',
    'contract.msvault': 'MSVault (cofre multisig)',
    'contract.msvaultDesc':
      'O MSVault cria um cofre compartilhado ou de longo prazo que exige várias assinaturas e uma senha. Ele impõe um saldo mínimo e um bloqueio por tempo.',
    'contract.multiSignature':
      'Multisignature: exige assinaturas de várias partes autorizadas.',
    'contract.msvaultSpending':
      'Requisitos de gasto: forneça uma assinatura válida e uma assinatura de dados verificada por senha, mantendo pelo menos 4000 satoshis, ou use uma assinatura válida após o fim do bloqueio de tempo.',
    'contract.msvaultUseCase':
      'Uso: adequado para propriedade compartilhada ou armazenamento de longo prazo com controles de acesso rigorosos.',
    'contract.p2pkh': 'P2PKH (Pay-to-Public-Key-Hash)',
    'contract.p2pkhDesc':
      'P2PKH é um script padrão do Bitcoin que protege UTXOs exigindo uma assinatura do proprietário do hash de chave pública especificado.',
    'contract.simplicity':
      'Simplicidade: fácil de usar e compatível com a maioria das carteiras Bitcoin.',
    'contract.p2pkhSpending':
      'Requisitos de gasto: forneça uma assinatura válida correspondente ao hash de chave pública do contrato.',
    'contract.p2pkhSecurity':
      'Segurança: método comprovado e confiável para proteger ativos digitais.',
    'contract.transfer': 'TransferWithTimeout',
    'contract.transferDesc':
      'TransferWithTimeout permite transferências condicionais com prazo. O destinatário pode reivindicar os fundos antes do prazo; depois, o remetente pode recuperá-los.',
    'contract.timeControl':
      'Controle por tempo: define um prazo para o destinatário reivindicar os fundos.',
    'contract.transferSpending':
      'Requisitos de gasto: o destinatário assina antes do prazo; depois, o remetente pode recuperar os fundos com uma assinatura válida.',
    'contract.transferUseCase':
      'Usos: útil para assinaturas, pagamentos condicionais ou situações semelhantes a escrow.',
    'contract.howToUse': 'Como usar contratos covenant',
    'contract.howToUseText':
      'Abra a seção Contratos, escolha um tipo de contrato, configure suas condições e implante-o. Para gastar UTXOs do contrato, cumpra os requisitos específicos acima. Instruções detalhadas e exemplos estão disponíveis na documentação do app.',
  },
  vi: {
    'contractView.title': 'Hợp đồng',
    'contractView.create': 'Tạo hợp đồng',
    'contractView.howWorks': 'Cách hoạt động',
    'contractView.pickTemplate': '1. Chọn mẫu',
    'contractView.fillInputs': '2. Điền đầu vào hàm tạo',
    'contractView.createStep': '3. Tạo hợp đồng',
    'contractView.selectContract': 'Chọn hợp đồng',
    'contractView.instantiated': 'Hợp đồng đã khởi tạo',
    'contractView.address': 'Địa chỉ',
    'contractView.tokenAddress': 'Địa chỉ token',
    'contractView.balance': 'Số dư',
    'contractView.noInstances': 'Chưa có thực thể hợp đồng nào.',
    'contractView.delete': 'Xóa',
    'contractView.update': 'Cập nhật',
    'contractView.back': 'Quay lại',
    'contractView.constructorArgs': 'Đối số hàm tạo',
    'contractView.fillRequired':
      'Điền mọi giá trị bắt buộc trước khi tạo hợp đồng.',
    'contractView.blockHeight': 'Độ cao block hiện tại',
    'contractView.blockHeightInfo': 'Các block tăng trung bình mỗi 10 phút.',
    'contractView.unavailable': 'Không khả dụng',
    'contractView.noInputs': 'Mẫu hợp đồng này không có đầu vào hàm tạo.',
    'contractView.datasigInfo': 'Thông tin chữ ký dữ liệu',
    'contractView.enterMessage': 'Nhập thông điệp cho {name}',
    'contractView.selectAddress': 'Chọn địa chỉ',
    'contractView.scanQr': 'Quét mã QR cho {name}',
    'contractView.signMessage': 'Ký thông điệp',
    'contractView.signingAddress': 'Địa chỉ ký',
    'contractView.signature': 'Chữ ký',
    'contractView.argumentTypeInfo': 'Thông tin kiểu đối số',
    'contractView.publicKeyInfo':
      'Khóa công khai dạng hex. Dùng “Chọn địa chỉ” để tự động điền.',
    'contractView.hashInfo':
      'Hash 20 byte (hex) của địa chỉ/khóa công khai. Dùng “Chọn địa chỉ”.',
    'contractView.enterType': 'Nhập giá trị phù hợp với kiểu: {type}.',
    'contractView.selected': 'Đã chọn {type}',
    'contractView.error': 'Lỗi',
    'contractView.addressCopied': 'Đã sao chép địa chỉ vào bộ nhớ tạm!',
    'contractView.copyFailed': 'Không thể sao chép địa chỉ.',
    'contractView.selectData': 'Hãy chọn địa chỉ và nhập dữ liệu cần ký.',
    'contractView.signatureGenerated': 'Đã tạo chữ ký thành công!',
    'contractView.signatureFailed': 'Không thể tạo chữ ký.',
    'contractView.noQr': 'Không phát hiện mã QR. Hãy thử lại.',
    'contractView.created': 'Đã tạo hợp đồng thành công!',
    'contractView.deleted': 'Đã xóa hợp đồng thành công!',
    'contractView.deleteFailed': 'Không thể xóa hợp đồng.',
    'contractView.updated': 'Đã cập nhật hợp đồng thành công!',
    'contractView.updateFailed': 'Không thể cập nhật hợp đồng.',
    'contractView.loadContractsFailed': 'Không thể tải các hợp đồng có sẵn.',
    'contractView.loadInstancesFailed': 'Không thể tải các thực thể hợp đồng.',
    'contractView.loadDetailsFailed':
      'Không thể tải thông tin chi tiết hợp đồng.',
    'contractView.createFailed': 'Không thể tạo hợp đồng: {message}',
    'contractView.deleteFailedFallback': 'Không thể xóa hợp đồng.',
    'contractView.updateFailedFallback': 'Không thể cập nhật hợp đồng.',
    'contractView.unknownError': 'Lỗi không xác định',
    'contractView.privateKeyUnavailable':
      'Khóa riêng không khả dụng cho địa chỉ này.',
    'contractView.errorPrefix': 'Lỗi: {message}',
    'contract.intro':
      'Hợp đồng covenant trong OPTN Wallet là hợp đồng thông minh áp đặt quy tắc chi tiêu tài sản số. Mỗi hợp đồng khóa tiền trong UTXO và chỉ có thể chi khi đáp ứng các điều kiện định trước.',
    'contract.available': 'Hợp đồng có sẵn',
    'contract.bip38': 'BIP38 (khóa riêng được bảo vệ bằng mật khẩu)',
    'contract.bip38Desc':
      'Hợp đồng BIP38 bảo vệ khóa riêng bằng mật khẩu. UTXO cần đúng mật khẩu và chữ ký hợp lệ.',
    'contract.passwordProtection':
      'Bảo vệ bằng mật khẩu: mã hóa khóa riêng bằng mật khẩu do người dùng đặt.',
    'contract.bip38Spending':
      'Điều kiện chi: cung cấp chữ ký chủ sở hữu hợp lệ và chữ ký dữ liệu xác minh mật khẩu.',
    'contract.bip38UseCase':
      'Trường hợp dùng: phù hợp để bảo vệ khóa riêng khỏi trộm cắp hoặc truy cập trái phép, nhất là khi lưu trữ dài hạn.',
    'contract.escrow': 'Escrow',
    'contract.escrowDesc':
      'Hợp đồng Escrow hỗ trợ giao dịch an toàn giữa người mua và người bán với trọng tài đáng tin cậy. Tiền chỉ được giải ngân khi trọng tài chấp thuận.',
    'contract.arbiter': 'Trọng tài: bên đáng tin cậy cho phép giải ngân.',
    'contract.escrowSpending':
      'Điều kiện chi: trọng tài cung cấp chữ ký hợp lệ và toàn bộ số tiền chuyển đến địa chỉ băm khóa công khai của người mua hoặc người bán.',
    'contract.escrowSecurity':
      'Bảo mật: tiền vẫn bị khóa đến khi trọng tài chấp thuận, giúp ngăn gian lận hoặc tranh chấp.',
    'contract.escrowMS2': 'EscrowMS2 (escrow nhiều bên)',
    'contract.escrowMS2Desc':
      'EscrowMS2 mở rộng escrow với hai trọng tài. Tiền có thể được giải ngân khi một trọng tài hoặc cả hai cùng chấp thuận.',
    'contract.multipleArbiters':
      'Nhiều trọng tài: hai trọng tài có thể cho phép giải ngân.',
    'contract.escrowMS2Spending':
      'Điều kiện chi: một hoặc cả hai trọng tài cung cấp chữ ký hợp lệ, và toàn bộ số tiền chuyển đến người mua hoặc người bán.',
    'contract.enhancedTrust':
      'Tin cậy nâng cao: hữu ích cho giao dịch cần nhiều bên đáng tin cậy.',
    'contract.msvault': 'MSVault (vault đa chữ ký)',
    'contract.msvaultDesc':
      'MSVault tạo vault dùng chung hoặc dài hạn, yêu cầu nhiều chữ ký và mật khẩu. Vault áp dụng số dư tối thiểu và khóa theo thời gian.',
    'contract.multiSignature':
      'Đa chữ ký: yêu cầu chữ ký từ nhiều bên được ủy quyền.',
    'contract.msvaultSpending':
      'Điều kiện chi: cung cấp chữ ký hợp lệ và chữ ký dữ liệu xác minh bằng mật khẩu, duy trì ít nhất 4000 satoshi, hoặc dùng chữ ký hợp lệ sau khi hết thời gian khóa.',
    'contract.msvaultUseCase':
      'Trường hợp dùng: phù hợp với sở hữu chung hoặc lưu trữ dài hạn có kiểm soát truy cập nghiêm ngặt.',
    'contract.p2pkh': 'P2PKH (Pay-to-Public-Key-Hash)',
    'contract.p2pkhDesc':
      'P2PKH là script Bitcoin tiêu chuẩn bảo vệ UTXO bằng cách yêu cầu chữ ký của chủ hash khóa công khai được chỉ định.',
    'contract.simplicity':
      'Đơn giản: dễ dùng và tương thích với hầu hết ví Bitcoin.',
    'contract.p2pkhSpending':
      'Điều kiện chi: cung cấp chữ ký hợp lệ khớp với hash khóa công khai trong hợp đồng.',
    'contract.p2pkhSecurity':
      'Bảo mật: phương pháp đã được kiểm chứng và đáng tin cậy để bảo vệ tài sản số.',
    'contract.transfer': 'TransferWithTimeout',
    'contract.transferDesc':
      'TransferWithTimeout cho phép chuyển tiền có điều kiện với thời hạn. Người nhận có thể nhận tiền trước hạn; sau đó người gửi có thể thu hồi.',
    'contract.timeControl':
      'Kiểm soát thời gian: đặt hạn để người nhận nhận tiền.',
    'contract.transferSpending':
      'Điều kiện chi: người nhận ký trước hạn; sau đó người gửi có thể thu hồi bằng chữ ký hợp lệ.',
    'contract.transferUseCase':
      'Trường hợp dùng: phù hợp cho đăng ký, thanh toán có điều kiện hoặc tình huống giống escrow.',
    'contract.howToUse': 'Cách dùng hợp đồng covenant',
    'contract.howToUseText':
      'Mở mục Hợp đồng, chọn loại hợp đồng, cấu hình điều kiện rồi triển khai. Để chi từ UTXO của hợp đồng, hãy đáp ứng các điều kiện chi tương ứng ở trên. Hướng dẫn chi tiết và ví dụ có trong tài liệu ứng dụng.',
  },
  'zh-TW': {
    'contractView.title': '合約',
    'contractView.create': '建立合約',
    'contractView.howWorks': '運作方式',
    'contractView.pickTemplate': '1. 選擇範本',
    'contractView.fillInputs': '2. 填寫建構函式輸入',
    'contractView.createStep': '3. 建立合約',
    'contractView.selectContract': '選擇合約',
    'contractView.instantiated': '已實例化的合約',
    'contractView.address': '地址',
    'contractView.tokenAddress': '代幣地址',
    'contractView.balance': '餘額',
    'contractView.noInstances': '尚無合約實例。',
    'contractView.delete': '刪除',
    'contractView.update': '更新',
    'contractView.back': '返回',
    'contractView.constructorArgs': '建構函式引數',
    'contractView.fillRequired': '建立合約前請填寫每個必要值。',
    'contractView.blockHeight': '目前區塊高度',
    'contractView.blockHeightInfo': '區塊平均每 10 分鐘增加一次。',
    'contractView.unavailable': '無法使用',
    'contractView.noInputs': '此合約範本沒有建構函式輸入。',
    'contractView.datasigInfo': '資料簽章資訊',
    'contractView.enterMessage': '輸入給 {name} 的訊息',
    'contractView.selectAddress': '選擇地址',
    'contractView.scanQr': '掃描 {name} 的 QR 碼',
    'contractView.signMessage': '簽署訊息',
    'contractView.signingAddress': '簽署地址',
    'contractView.signature': '簽章',
    'contractView.argumentTypeInfo': '引數類型資訊',
    'contractView.publicKeyInfo': '十六進位公鑰。使用「選擇地址」自動填入。',
    'contractView.hashInfo':
      '地址／公鑰的 20 位元組雜湊（十六進位）。使用「選擇地址」。',
    'contractView.enterType': '輸入符合類型的值：{type}。',
    'contractView.selected': '已選擇 {type}',
    'contractView.error': '錯誤',
    'contractView.addressCopied': '地址已複製到剪貼簿！',
    'contractView.copyFailed': '複製地址失敗。',
    'contractView.selectData': '請選擇地址並輸入要簽署的資料。',
    'contractView.signatureGenerated': '簽章已成功產生！',
    'contractView.signatureFailed': '產生簽章失敗。',
    'contractView.noQr': '未偵測到 QR 碼。請再試一次。',
    'contractView.created': '合約已成功建立！',
    'contractView.deleted': '合約已成功刪除！',
    'contractView.deleteFailed': '刪除合約失敗。',
    'contractView.updated': '合約已成功更新！',
    'contractView.updateFailed': '更新合約失敗。',
    'contractView.loadContractsFailed': '載入可用合約失敗。',
    'contractView.loadInstancesFailed': '載入合約實例失敗。',
    'contractView.loadDetailsFailed': '載入合約詳細資料失敗。',
    'contractView.createFailed': '建立合約失敗：{message}',
    'contractView.deleteFailedFallback': '刪除合約失敗。',
    'contractView.updateFailedFallback': '更新合約失敗。',
    'contractView.unknownError': '未知錯誤',
    'contractView.privateKeyUnavailable': '此地址的私鑰無法使用。',
    'contractView.errorPrefix': '錯誤：{message}',
    'contract.intro':
      'OPTN Wallet 中的 covenant 合約是用來強制執行數位資產花費規則的智慧合約。每個合約都會將資金鎖在 UTXO 中，只有符合預先定義的條件才能花費。',
    'contract.available': '可用合約',
    'contract.bip38': 'BIP38（受密碼保護的私鑰）',
    'contract.bip38Desc':
      'BIP38 合約使用密碼保護私鑰。其 UTXO 需要正確密碼與有效簽章。',
    'contract.passwordProtection': '密碼保護：使用使用者設定的密碼加密私鑰。',
    'contract.bip38Spending':
      '花費條件：提供有效的擁有者簽章，以及驗證密碼的資料簽章。',
    'contract.bip38UseCase':
      '用途：適合防止私鑰被竊或未經授權存取，尤其適合長期儲存。',
    'contract.escrow': 'Escrow',
    'contract.escrowDesc':
      'Escrow 合約支援買方與賣方透過可信仲裁者進行安全交易。只有仲裁者核准後才會釋放資金。',
    'contract.arbiter': '仲裁者：授權釋放資金的可信任一方。',
    'contract.escrowSpending':
      '花費條件：仲裁者提供有效簽章，全部金額會送往買方或賣方的公鑰雜湊地址。',
    'contract.escrowSecurity':
      '安全性：資金會保持鎖定直到仲裁者核准，有助於防止詐欺或爭議。',
    'contract.escrowMS2': 'EscrowMS2（多方託管）',
    'contract.escrowMS2Desc':
      'EscrowMS2 以兩位仲裁者擴充 escrow。資金可由一位仲裁者核准，或由兩位仲裁者共同核准後釋放。',
    'contract.multipleArbiters': '多位仲裁者：兩位仲裁者可以授權釋放資金。',
    'contract.escrowMS2Spending':
      '花費條件：一位或兩位仲裁者提供有效簽章，全部金額會送往買方或賣方。',
    'contract.enhancedTrust': '增強信任：適合需要多個可信任方的交易。',
    'contract.msvault': 'MSVault（多重簽章保管庫）',
    'contract.msvaultDesc':
      'MSVault 建立需要多重簽章與密碼的共享或長期保管庫，並強制執行最低餘額與時間鎖定。',
    'contract.multiSignature': '多重簽章：需要多位授權方的簽章。',
    'contract.msvaultSpending':
      '花費條件：提供有效簽章與經密碼驗證的資料簽章，同時維持至少 4000 satoshis；或在時間鎖定到期後使用有效簽章。',
    'contract.msvaultUseCase':
      '用途：適合共享所有權或具有嚴格存取控制的長期儲存。',
    'contract.p2pkh': 'P2PKH（Pay-to-Public-Key-Hash）',
    'contract.p2pkhDesc':
      'P2PKH 是標準 Bitcoin script，要求指定公鑰雜湊擁有者簽章，以保護 UTXO。',
    'contract.simplicity': '簡單：容易使用，且與大多數 Bitcoin 錢包相容。',
    'contract.p2pkhSpending': '花費條件：提供與合約中公鑰雜湊相符的有效簽章。',
    'contract.p2pkhSecurity': '安全性：保護數位資產的成熟可靠方法。',
    'contract.transfer': 'TransferWithTimeout',
    'contract.transferDesc':
      'TransferWithTimeout 允許附帶期限的條件式轉帳。接收者可在逾時前領取資金；之後寄件者可以取回資金。',
    'contract.timeControl': '時間控制：設定接收者領取資金的期限。',
    'contract.transferSpending':
      '花費條件：接收者在逾時前簽署；之後寄件者可用有效簽章取回資金。',
    'contract.transferUseCase': '用途：適合訂閱、條件式付款或類似託管的情境。',
    'contract.howToUse': '如何使用 covenant 合約',
    'contract.howToUseText':
      '開啟「合約」區段，選擇合約類型、設定條件並部署。若要花費合約 UTXO，請符合上方列出的特定花費條件。詳細說明與範例請參閱應用程式文件。',
  },
  fr: {
    'contractView.title': 'Contrats',
    'contractView.create': 'Créer un contrat',
    'contractView.howWorks': 'Fonctionnement',
    'contractView.pickTemplate': '1. Choisir un modèle',
    'contractView.fillInputs': '2. Remplir les entrées du constructeur',
    'contractView.createStep': '3. Créer le contrat',
    'contractView.selectContract': 'Sélectionner un contrat',
    'contractView.instantiated': 'Contrats instanciés',
    'contractView.address': 'Adresse',
    'contractView.tokenAddress': 'Adresse du token',
    'contractView.balance': 'Solde',
    'contractView.noInstances': 'Aucune instance de contrat pour le moment.',
    'contractView.delete': 'Supprimer',
    'contractView.update': 'Mettre à jour',
    'contractView.back': 'Retour',
    'contractView.constructorArgs': 'Arguments du constructeur',
    'contractView.fillRequired':
      'Remplissez chaque valeur obligatoire avant de créer le contrat.',
    'contractView.blockHeight': 'Hauteur actuelle du bloc',
    'contractView.blockHeightInfo':
      'Les blocs progressent en moyenne toutes les 10 minutes.',
    'contractView.unavailable': 'Indisponible',
    'contractView.noInputs':
      'Ce modèle de contrat ne possède aucune entrée de constructeur.',
    'contractView.datasigInfo': 'Informations sur la signature de données',
    'contractView.enterMessage': 'Saisissez un message pour {name}',
    'contractView.selectAddress': 'Sélectionner une adresse',
    'contractView.scanQr': 'Scanner le QR code de {name}',
    'contractView.signMessage': 'Signer le message',
    'contractView.signingAddress': 'Adresse de signature',
    'contractView.signature': 'Signature',
    'contractView.argumentTypeInfo': 'Informations sur le type d’argument',
    'contractView.publicKeyInfo':
      'Clé publique en hexadécimal. Utilisez « Sélectionner une adresse » pour remplir automatiquement.',
    'contractView.hashInfo':
      'Hash de 20 octets (hexadécimal) d’une adresse ou clé publique. Utilisez « Sélectionner une adresse ».',
    'contractView.enterType':
      'Saisissez une valeur correspondant au type : {type}.',
    'contractView.selected': '{type} sélectionné',
    'contractView.error': 'Erreur',
    'contractView.addressCopied': 'Adresse copiée dans le presse-papiers !',
    'contractView.copyFailed': 'Échec de la copie de l’adresse.',
    'contractView.selectData':
      'Sélectionnez une adresse et saisissez les données à signer.',
    'contractView.signatureGenerated': 'Signature générée avec succès !',
    'contractView.signatureFailed': 'Échec de la génération de la signature.',
    'contractView.noQr': 'Aucun QR code détecté. Réessayez.',
    'contractView.created': 'Contrat créé avec succès !',
    'contractView.deleted': 'Contrat supprimé avec succès !',
    'contractView.deleteFailed': 'Échec de la suppression du contrat.',
    'contractView.updated': 'Contrat mis à jour avec succès !',
    'contractView.updateFailed': 'Échec de la mise à jour du contrat.',
    'contractView.loadContractsFailed':
      'Échec du chargement des contrats disponibles.',
    'contractView.loadInstancesFailed':
      'Échec du chargement des instances de contrat.',
    'contractView.loadDetailsFailed':
      'Échec du chargement des détails du contrat.',
    'contractView.createFailed': 'Échec de la création du contrat : {message}',
    'contractView.deleteFailedFallback': 'Échec de la suppression du contrat.',
    'contractView.updateFailedFallback': 'Échec de la mise à jour du contrat.',
    'contractView.unknownError': 'Erreur inconnue',
    'contractView.privateKeyUnavailable':
      'Clé privée indisponible pour cette adresse.',
    'contractView.errorPrefix': 'Erreur : {message}',
    'contract.intro':
      'Les contrats covenant d’OPTN Wallet sont des contrats intelligents qui imposent des règles de dépense des actifs numériques. Chaque contrat verrouille des fonds dans des UTXO qui ne peuvent être dépensés qu’en respectant des conditions prédéfinies.',
    'contract.available': 'Contrats disponibles',
    'contract.bip38': 'BIP38 (clés privées protégées par mot de passe)',
    'contract.bip38Desc':
      'Le contrat BIP38 protège les clés privées avec un mot de passe. Ses UTXO exigent le bon mot de passe et une signature valide.',
    'contract.passwordProtection':
      'Protection par mot de passe : chiffre votre clé privée avec un mot de passe défini par l’utilisateur.',
    'contract.bip38Spending':
      'Conditions de dépense : fournir une signature valide du propriétaire et une signature de données vérifiant le mot de passe.',
    'contract.bip38UseCase':
      'Usage : idéal pour protéger les clés privées contre le vol ou l’accès non autorisé, notamment pour le stockage à long terme.',
    'contract.escrow': 'Escrow',
    'contract.escrowDesc':
      'Le contrat Escrow permet des transactions sécurisées entre acheteur et vendeur avec un arbitre de confiance. Les fonds ne sont libérés qu’avec son accord.',
    'contract.arbiter':
      'Arbitre : partie de confiance qui autorise la libération des fonds.',
    'contract.escrowSpending':
      'Conditions de dépense : l’arbitre fournit une signature valide et le montant total va à l’adresse de hash de clé publique de l’acheteur ou du vendeur.',
    'contract.escrowSecurity':
      'Sécurité : les fonds restent verrouillés jusqu’à l’approbation de l’arbitre, ce qui aide à prévenir fraude et litiges.',
    'contract.escrowMS2': 'EscrowMS2 (escrow multipartite)',
    'contract.escrowMS2Desc':
      'EscrowMS2 étend l’escrow avec deux arbitres. Les fonds peuvent être libérés avec l’accord d’un arbitre ou l’accord conjoint des deux.',
    'contract.multipleArbiters':
      'Arbitres multiples : deux arbitres peuvent autoriser la libération des fonds.',
    'contract.escrowMS2Spending':
      'Conditions de dépense : un arbitre ou les deux fournissent des signatures valides, et le montant total va à l’acheteur ou au vendeur.',
    'contract.enhancedTrust':
      'Confiance renforcée : utile pour les transactions exigeant plusieurs parties de confiance.',
    'contract.msvault': 'MSVault (coffre multisignature)',
    'contract.msvaultDesc':
      'MSVault crée un coffre partagé ou de long terme qui exige plusieurs signatures et un mot de passe. Il impose un solde minimal et un verrouillage temporel.',
    'contract.multiSignature':
      'Multisignature : exige les signatures de plusieurs parties autorisées.',
    'contract.msvaultSpending':
      'Conditions de dépense : fournir une signature valide et une signature de données vérifiée par mot de passe en conservant au moins 4000 satoshis, ou utiliser une signature valide après expiration du verrouillage.',
    'contract.msvaultUseCase':
      'Usage : adapté à la propriété partagée ou au stockage de long terme avec des contrôles d’accès stricts.',
    'contract.p2pkh': 'P2PKH (Pay-to-Public-Key-Hash)',
    'contract.p2pkhDesc':
      'P2PKH est un script Bitcoin standard qui protège les UTXO en exigeant la signature du propriétaire du hash de clé publique indiqué.',
    'contract.simplicity':
      'Simplicité : facile à utiliser et compatible avec la plupart des portefeuilles Bitcoin.',
    'contract.p2pkhSpending':
      'Conditions de dépense : fournir une signature valide correspondant au hash de clé publique du contrat.',
    'contract.p2pkhSecurity':
      'Sécurité : méthode éprouvée et fiable pour protéger les actifs numériques.',
    'contract.transfer': 'TransferWithTimeout',
    'contract.transferDesc':
      'TransferWithTimeout permet des transferts conditionnels avec une échéance. Le destinataire peut réclamer les fonds avant l’expiration ; ensuite, l’expéditeur peut les récupérer.',
    'contract.timeControl':
      'Contrôle temporel : fixe une échéance pour que le destinataire réclame les fonds.',
    'contract.transferSpending':
      'Conditions de dépense : le destinataire signe avant l’expiration ; ensuite, l’expéditeur peut récupérer les fonds avec une signature valide.',
    'contract.transferUseCase':
      'Usages : utile pour les abonnements, paiements conditionnels ou scénarios de type escrow.',
    'contract.howToUse': 'Utiliser les contrats covenant',
    'contract.howToUseText':
      'Ouvrez la section Contrats, choisissez un type de contrat, configurez ses conditions et déployez-le. Pour dépenser les UTXO du contrat, respectez les conditions de dépense indiquées. Des instructions détaillées et des exemples figurent dans la documentation de l’application.',
  },
  ko: {
    'contractView.title': '컨트랙트',
    'contractView.create': '컨트랙트 만들기',
    'contractView.howWorks': '작동 방식',
    'contractView.pickTemplate': '1. 템플릿 선택',
    'contractView.fillInputs': '2. 생성자 입력값 작성',
    'contractView.createStep': '3. 컨트랙트 만들기',
    'contractView.selectContract': '컨트랙트 선택',
    'contractView.instantiated': '인스턴스화된 컨트랙트',
    'contractView.address': '주소',
    'contractView.tokenAddress': '토큰 주소',
    'contractView.balance': '잔액',
    'contractView.noInstances': '아직 컨트랙트 인스턴스가 없습니다.',
    'contractView.delete': '삭제',
    'contractView.update': '업데이트',
    'contractView.back': '뒤로',
    'contractView.constructorArgs': '생성자 인수',
    'contractView.fillRequired':
      '컨트랙트를 만들기 전에 필수 값을 모두 입력하세요.',
    'contractView.blockHeight': '현재 블록 높이',
    'contractView.blockHeightInfo': '블록은 평균 10분 간격으로 증가합니다.',
    'contractView.unavailable': '사용할 수 없음',
    'contractView.noInputs': '이 컨트랙트 템플릿에는 생성자 입력값이 없습니다.',
    'contractView.datasigInfo': '데이터 서명 정보',
    'contractView.enterMessage': '{name}의 메시지 입력',
    'contractView.selectAddress': '주소 선택',
    'contractView.scanQr': '{name}의 QR 코드 스캔',
    'contractView.signMessage': '메시지 서명',
    'contractView.signingAddress': '서명 주소',
    'contractView.signature': '서명',
    'contractView.argumentTypeInfo': '인수 유형 정보',
    'contractView.publicKeyInfo':
      '16진수 공개 키입니다. 자동으로 입력하려면 “주소 선택”을 사용하세요.',
    'contractView.hashInfo':
      '주소/공개 키의 20바이트 해시(16진수)입니다. “주소 선택”을 사용하세요.',
    'contractView.enterType': '유형에 맞는 값을 입력하세요: {type}.',
    'contractView.selected': '{type} 선택됨',
    'contractView.error': '오류',
    'contractView.addressCopied': '주소를 클립보드에 복사했습니다!',
    'contractView.copyFailed': '주소를 복사하지 못했습니다.',
    'contractView.selectData': '주소를 선택하고 서명할 데이터를 입력하세요.',
    'contractView.signatureGenerated': '서명을 성공적으로 생성했습니다!',
    'contractView.signatureFailed': '서명을 생성하지 못했습니다.',
    'contractView.noQr': 'QR 코드를 찾지 못했습니다. 다시 시도하세요.',
    'contractView.created': '컨트랙트를 성공적으로 만들었습니다!',
    'contractView.deleted': '컨트랙트를 성공적으로 삭제했습니다!',
    'contractView.deleteFailed': '컨트랙트를 삭제하지 못했습니다.',
    'contractView.updated': '컨트랙트를 성공적으로 업데이트했습니다!',
    'contractView.updateFailed': '컨트랙트를 업데이트하지 못했습니다.',
    'contractView.loadContractsFailed':
      '사용 가능한 컨트랙트를 불러오지 못했습니다.',
    'contractView.loadInstancesFailed':
      '컨트랙트 인스턴스를 불러오지 못했습니다.',
    'contractView.loadDetailsFailed':
      '컨트랙트 세부 정보를 불러오지 못했습니다.',
    'contractView.createFailed': '컨트랙트를 만들지 못했습니다: {message}',
    'contractView.deleteFailedFallback': '컨트랙트를 삭제하지 못했습니다.',
    'contractView.updateFailedFallback': '컨트랙트를 업데이트하지 못했습니다.',
    'contractView.unknownError': '알 수 없는 오류',
    'contractView.privateKeyUnavailable':
      '이 주소의 개인 키를 사용할 수 없습니다.',
    'contractView.errorPrefix': '오류: {message}',
    'contract.intro':
      'OPTN Wallet의 covenant 컨트랙트는 디지털 자산의 사용 규칙을 적용하는 스마트 컨트랙트입니다. 각 컨트랙트는 UTXO에 자금을 잠그며 미리 정한 조건을 충족해야 사용할 수 있습니다.',
    'contract.available': '사용 가능한 컨트랙트',
    'contract.bip38': 'BIP38(비밀번호로 보호되는 개인 키)',
    'contract.bip38Desc':
      'BIP38 컨트랙트는 비밀번호로 개인 키를 보호합니다. UTXO를 사용하려면 올바른 비밀번호와 유효한 서명이 모두 필요합니다.',
    'contract.passwordProtection':
      '비밀번호 보호: 사용자가 정한 비밀번호로 개인 키를 암호화합니다.',
    'contract.bip38Spending':
      '사용 조건: 유효한 소유자 서명과 비밀번호를 확인하는 데이터 서명을 제공합니다.',
    'contract.bip38UseCase':
      '용도: 특히 장기 보관에서 개인 키를 도난이나 무단 접근으로부터 보호하는 데 적합합니다.',
    'contract.escrow': 'Escrow',
    'contract.escrowDesc':
      'Escrow 컨트랙트는 신뢰할 수 있는 중재자와 구매자·판매자 사이의 안전한 거래를 지원합니다. 중재자가 승인해야만 자금이 지급됩니다.',
    'contract.arbiter':
      '중재자: 자금 지급을 승인하는 신뢰할 수 있는 당사자입니다.',
    'contract.escrowSpending':
      '사용 조건: 중재자가 유효한 서명을 제공하며 전액이 구매자 또는 판매자의 공개 키 해시 주소로 이동합니다.',
    'contract.escrowSecurity':
      '보안: 중재자가 승인할 때까지 자금이 잠겨 사기나 분쟁을 예방하는 데 도움이 됩니다.',
    'contract.escrowMS2': 'EscrowMS2(다자간 에스크로)',
    'contract.escrowMS2Desc':
      'EscrowMS2는 두 명의 중재자를 사용하도록 에스크로를 확장합니다. 한 명의 승인 또는 두 중재자의 공동 승인으로 자금을 지급할 수 있습니다.',
    'contract.multipleArbiters':
      '복수 중재자: 두 중재자가 자금 지급을 승인할 수 있습니다.',
    'contract.escrowMS2Spending':
      '사용 조건: 한 명 또는 두 중재자가 유효한 서명을 제공하며 전액이 구매자나 판매자에게 이동합니다.',
    'contract.enhancedTrust':
      '강화된 신뢰: 여러 신뢰 당사자가 필요한 거래에 유용합니다.',
    'contract.msvault': 'MSVault(다중 서명 볼트)',
    'contract.msvaultDesc':
      'MSVault는 여러 서명과 비밀번호가 필요한 공유 또는 장기 보관용 볼트를 만듭니다. 최소 잔액과 시간 잠금을 적용합니다.',
    'contract.multiSignature':
      '다중 서명: 여러 승인 당사자의 서명이 필요합니다.',
    'contract.msvaultSpending':
      '사용 조건: 유효한 서명과 비밀번호로 확인된 데이터 서명을 제공하고 최소 4000 satoshi를 유지하거나, 시간 잠금 만료 후 유효한 서명을 사용합니다.',
    'contract.msvaultUseCase':
      '용도: 엄격한 접근 제어가 필요한 공동 소유 또는 장기 보관에 적합합니다.',
    'contract.p2pkh': 'P2PKH(Pay-to-Public-Key-Hash)',
    'contract.p2pkhDesc':
      'P2PKH는 지정된 공개 키 해시 소유자의 서명을 요구해 UTXO를 보호하는 표준 Bitcoin 스크립트입니다.',
    'contract.simplicity':
      '간단함: 사용하기 쉽고 대부분의 Bitcoin 지갑과 호환됩니다.',
    'contract.p2pkhSpending':
      '사용 조건: 컨트랙트의 공개 키 해시와 일치하는 유효한 서명을 제공합니다.',
    'contract.p2pkhSecurity':
      '보안: 디지털 자산을 보호하는 검증된 신뢰성 높은 방법입니다.',
    'contract.transfer': 'TransferWithTimeout',
    'contract.transferDesc':
      'TransferWithTimeout은 기한이 있는 조건부 전송을 지원합니다. 수신자는 기한 전에 자금을 청구하고, 이후에는 송신자가 회수할 수 있습니다.',
    'contract.timeControl':
      '시간 제어: 수신자가 자금을 청구할 기한을 설정합니다.',
    'contract.transferSpending':
      '사용 조건: 수신자가 기한 전에 서명하고, 이후에는 송신자가 유효한 서명으로 회수할 수 있습니다.',
    'contract.transferUseCase':
      '용도: 구독, 조건부 결제 또는 에스크로와 유사한 상황에 유용합니다.',
    'contract.howToUse': 'Covenant 컨트랙트 사용 방법',
    'contract.howToUseText':
      '컨트랙트 섹션을 열고 유형을 선택한 뒤 조건을 구성하고 배포하세요. 컨트랙트 UTXO를 사용하려면 위의 사용 조건을 충족해야 합니다. 자세한 지침과 예시는 앱 문서에서 확인할 수 있습니다.',
  },
  ja: {
    'contractView.title': 'コントラクト',
    'contractView.create': 'コントラクトを作成',
    'contractView.howWorks': '仕組み',
    'contractView.pickTemplate': '1. テンプレートを選択',
    'contractView.fillInputs': '2. コンストラクター入力を入力',
    'contractView.createStep': '3. コントラクトを作成',
    'contractView.selectContract': 'コントラクトを選択',
    'contractView.instantiated': 'インスタンス化されたコントラクト',
    'contractView.address': 'アドレス',
    'contractView.tokenAddress': 'トークンアドレス',
    'contractView.balance': '残高',
    'contractView.noInstances': 'コントラクトのインスタンスはまだありません。',
    'contractView.delete': '削除',
    'contractView.update': '更新',
    'contractView.back': '戻る',
    'contractView.constructorArgs': 'コンストラクター引数',
    'contractView.fillRequired':
      'コントラクトを作成する前に、必須項目をすべて入力してください。',
    'contractView.blockHeight': '現在のブロック高',
    'contractView.blockHeightInfo': 'ブロックは平均 10 分間隔で増加します。',
    'contractView.unavailable': '利用できません',
    'contractView.noInputs':
      'このコントラクトテンプレートにはコンストラクター入力がありません。',
    'contractView.datasigInfo': 'データ署名情報',
    'contractView.enterMessage': '{name} のメッセージを入力',
    'contractView.selectAddress': 'アドレスを選択',
    'contractView.scanQr': '{name} の QR コードをスキャン',
    'contractView.signMessage': 'メッセージに署名',
    'contractView.signingAddress': '署名アドレス',
    'contractView.signature': '署名',
    'contractView.argumentTypeInfo': '引数型情報',
    'contractView.publicKeyInfo':
      '16 進数の公開鍵。「アドレスを選択」で自動入力できます。',
    'contractView.hashInfo':
      'アドレス／公開鍵の 20 バイトハッシュ（16 進数）。「アドレスを選択」を使用してください。',
    'contractView.enterType': '型に合う値を入力してください：{type}。',
    'contractView.selected': '{type} を選択済み',
    'contractView.error': 'エラー',
    'contractView.addressCopied': 'アドレスをクリップボードにコピーしました！',
    'contractView.copyFailed': 'アドレスをコピーできませんでした。',
    'contractView.selectData':
      'アドレスを選択し、署名するデータを入力してください。',
    'contractView.signatureGenerated': '署名を生成しました！',
    'contractView.signatureFailed': '署名を生成できませんでした。',
    'contractView.noQr':
      'QR コードを検出できませんでした。もう一度お試しください。',
    'contractView.created': 'コントラクトを作成しました！',
    'contractView.deleted': 'コントラクトを削除しました！',
    'contractView.deleteFailed': 'コントラクトを削除できませんでした。',
    'contractView.updated': 'コントラクトを更新しました！',
    'contractView.updateFailed': 'コントラクトを更新できませんでした。',
    'contractView.loadContractsFailed':
      '利用可能なコントラクトを読み込めませんでした。',
    'contractView.loadInstancesFailed':
      'コントラクトのインスタンスを読み込めませんでした。',
    'contractView.loadDetailsFailed':
      'コントラクトの詳細を読み込めませんでした。',
    'contractView.createFailed':
      'コントラクトを作成できませんでした：{message}',
    'contractView.deleteFailedFallback': 'コントラクトを削除できませんでした。',
    'contractView.updateFailedFallback': 'コントラクトを更新できませんでした。',
    'contractView.unknownError': '不明なエラー',
    'contractView.privateKeyUnavailable':
      'このアドレスでは秘密鍵を利用できません。',
    'contractView.errorPrefix': 'エラー：{message}',
    'contract.intro':
      'OPTN Wallet の covenant コントラクトは、デジタル資産の支出ルールを強制するスマートコントラクトです。各コントラクトは UTXO に資金をロックし、あらかじめ定めた条件を満たした場合のみ使用できます。',
    'contract.available': '利用可能なコントラクト',
    'contract.bip38': 'BIP38（パスワードで保護された秘密鍵）',
    'contract.bip38Desc':
      'BIP38 コントラクトはパスワードで秘密鍵を保護します。UTXO の使用には正しいパスワードと有効な署名が必要です。',
    'contract.passwordProtection':
      'パスワード保護：ユーザーが設定したパスワードで秘密鍵を暗号化します。',
    'contract.bip38Spending':
      '使用条件：有効な所有者署名と、パスワードを検証するデータ署名を提供します。',
    'contract.bip38UseCase':
      '用途：特に長期保管で、秘密鍵を盗難や不正アクセスから守るのに適しています。',
    'contract.escrow': 'Escrow',
    'contract.escrowDesc':
      'Escrow コントラクトは、信頼できる仲裁者を介して買い手と売り手の安全な取引を支援します。資金は仲裁者の承認がある場合のみ解放されます。',
    'contract.arbiter': '仲裁者：資金の解放を承認する信頼できる当事者。',
    'contract.escrowSpending':
      '使用条件：仲裁者が有効な署名を提供し、全額が買い手または売り手の公開鍵ハッシュアドレスに送られます。',
    'contract.escrowSecurity':
      '安全性：仲裁者が承認するまで資金をロックし、詐欺や紛争の防止に役立ちます。',
    'contract.escrowMS2': 'EscrowMS2（マルチパーティーエスクロー）',
    'contract.escrowMS2Desc':
      'EscrowMS2 は 2 人の仲裁者に対応します。1 人の承認、または 2 人の共同承認で資金を解放できます。',
    'contract.multipleArbiters':
      '複数の仲裁者：2 人の仲裁者が資金の解放を承認できます。',
    'contract.escrowMS2Spending':
      '使用条件：1 人または 2 人の仲裁者が有効な署名を提供し、全額が買い手または売り手に送られます。',
    'contract.enhancedTrust':
      '信頼性の向上：複数の信頼できる当事者が必要な取引に便利です。',
    'contract.msvault': 'MSVault（マルチシグ保管庫）',
    'contract.msvaultDesc':
      'MSVault は複数の署名とパスワードを必要とする共有または長期保管用の保管庫を作成します。最低残高とタイムロックを適用します。',
    'contract.multiSignature':
      'マルチシグ：複数の承認済み当事者の署名が必要です。',
    'contract.msvaultSpending':
      '使用条件：有効な署名とパスワードで検証したデータ署名を提供し、少なくとも 4000 satoshis を維持するか、タイムロック後に有効な署名を使用します。',
    'contract.msvaultUseCase':
      '用途：厳格なアクセス制御が必要な共有所有や長期保管に適しています。',
    'contract.p2pkh': 'P2PKH（Pay-to-Public-Key-Hash）',
    'contract.p2pkhDesc':
      'P2PKH は、指定された公開鍵ハッシュの所有者による署名を要求して UTXO を保護する標準 Bitcoin スクリプトです。',
    'contract.simplicity':
      'シンプル：使いやすく、ほとんどの Bitcoin ウォレットと互換性があります。',
    'contract.p2pkhSpending':
      '使用条件：コントラクト内の公開鍵ハッシュに一致する有効な署名を提供します。',
    'contract.p2pkhSecurity':
      '安全性：デジタル資産を保護する実績のある信頼性の高い方法です。',
    'contract.transfer': 'TransferWithTimeout',
    'contract.transferDesc':
      'TransferWithTimeout は期限付きの条件付き送金を可能にします。受取人は期限前に資金を請求でき、期限後は送信者が取り戻せます。',
    'contract.timeControl':
      '時間制御：受取人が資金を請求できる期限を設定します。',
    'contract.transferSpending':
      '使用条件：受取人が期限前に署名し、期限後は送信者が有効な署名で取り戻せます。',
    'contract.transferUseCase':
      '用途：サブスクリプション、条件付き支払い、エスクローに似た場面に便利です。',
    'contract.howToUse': 'Covenant コントラクトの使い方',
    'contract.howToUseText':
      '「コントラクト」を開き、種類を選び、条件を設定してデプロイします。コントラクト UTXO を使用するには、上記の使用条件を満たしてください。詳しい手順と例はアプリのドキュメントにあります。',
  },
  ru: {
    'contractView.title': 'Контракты',
    'contractView.create': 'Создать контракт',
    'contractView.howWorks': 'Как это работает',
    'contractView.pickTemplate': '1. Выберите шаблон',
    'contractView.fillInputs': '2. Заполните входы конструктора',
    'contractView.createStep': '3. Создайте контракт',
    'contractView.selectContract': 'Выберите контракт',
    'contractView.instantiated': 'Созданные экземпляры контрактов',
    'contractView.address': 'Адрес',
    'contractView.tokenAddress': 'Адрес токена',
    'contractView.balance': 'Баланс',
    'contractView.noInstances': 'Экземпляров контрактов пока нет.',
    'contractView.delete': 'Удалить',
    'contractView.update': 'Обновить',
    'contractView.back': 'Назад',
    'contractView.constructorArgs': 'Аргументы конструктора',
    'contractView.fillRequired':
      'Заполните все обязательные значения перед созданием контракта.',
    'contractView.blockHeight': 'Текущая высота блока',
    'contractView.blockHeightInfo':
      'Блоки добавляются в среднем каждые 10 минут.',
    'contractView.unavailable': 'Недоступно',
    'contractView.noInputs':
      'В этом шаблоне контракта нет входов конструктора.',
    'contractView.datasigInfo': 'Сведения о подписи данных',
    'contractView.enterMessage': 'Введите сообщение для {name}',
    'contractView.selectAddress': 'Выбрать адрес',
    'contractView.scanQr': 'Сканировать QR-код для {name}',
    'contractView.signMessage': 'Подписать сообщение',
    'contractView.signingAddress': 'Адрес подписи',
    'contractView.signature': 'Подпись',
    'contractView.argumentTypeInfo': 'Сведения о типе аргумента',
    'contractView.publicKeyInfo':
      'Открытый ключ в шестнадцатеричном виде. Используйте «Выбрать адрес» для автоматического заполнения.',
    'contractView.hashInfo':
      '20-байтный хеш адреса или открытого ключа (hex). Используйте «Выбрать адрес».',
    'contractView.enterType': 'Введите значение типа {type}.',
    'contractView.selected': 'Выбрано: {type}',
    'contractView.error': 'Ошибка',
    'contractView.addressCopied': 'Адрес скопирован в буфер обмена!',
    'contractView.copyFailed': 'Не удалось скопировать адрес.',
    'contractView.selectData': 'Выберите адрес и введите данные для подписи.',
    'contractView.signatureGenerated': 'Подпись успешно создана!',
    'contractView.signatureFailed': 'Не удалось создать подпись.',
    'contractView.noQr': 'QR-код не обнаружен. Повторите попытку.',
    'contractView.created': 'Контракт успешно создан!',
    'contractView.deleted': 'Контракт успешно удалён!',
    'contractView.deleteFailed': 'Не удалось удалить контракт.',
    'contractView.updated': 'Контракт успешно обновлён!',
    'contractView.updateFailed': 'Не удалось обновить контракт.',
    'contractView.loadContractsFailed':
      'Не удалось загрузить доступные контракты.',
    'contractView.loadInstancesFailed':
      'Не удалось загрузить экземпляры контрактов.',
    'contractView.loadDetailsFailed':
      'Не удалось загрузить сведения о контракте.',
    'contractView.createFailed': 'Не удалось создать контракт: {message}',
    'contractView.deleteFailedFallback': 'Не удалось удалить контракт.',
    'contractView.updateFailedFallback': 'Не удалось обновить контракт.',
    'contractView.unknownError': 'Неизвестная ошибка',
    'contractView.privateKeyUnavailable':
      'Закрытый ключ для этого адреса недоступен.',
    'contractView.errorPrefix': 'Ошибка: {message}',
    'contract.intro':
      'Covenant-контракты в OPTN Wallet — это смарт-контракты, которые устанавливают правила расходования цифровых активов. Каждый контракт блокирует средства в UTXO, которые можно потратить только при выполнении заданных условий.',
    'contract.available': 'Доступные контракты',
    'contract.bip38': 'BIP38 (закрытые ключи, защищённые паролем)',
    'contract.bip38Desc':
      'Контракт BIP38 защищает закрытые ключи паролем. Для его UTXO нужны правильный пароль и действительная подпись.',
    'contract.passwordProtection':
      'Защита паролем: шифрует закрытый ключ паролем, заданным пользователем.',
    'contract.bip38Spending':
      'Условия расходования: действительная подпись владельца и подпись данных, подтверждающая пароль.',
    'contract.bip38UseCase':
      'Применение: подходит для защиты закрытых ключей от кражи или несанкционированного доступа, особенно при долгосрочном хранении.',
    'contract.escrow': 'Escrow',
    'contract.escrowDesc':
      'Контракт Escrow обеспечивает безопасные сделки между покупателем и продавцом с доверенным арбитром. Средства выпускаются только с одобрения арбитра.',
    'contract.arbiter':
      'Арбитр: доверенная сторона, разрешающая выпуск средств.',
    'contract.escrowSpending':
      'Условия расходования: арбитр предоставляет действительную подпись, а вся сумма поступает на адрес хеша открытого ключа покупателя или продавца.',
    'contract.escrowSecurity':
      'Безопасность: средства остаются заблокированными до одобрения арбитра, что помогает предотвращать мошенничество и споры.',
    'contract.escrowMS2': 'EscrowMS2 (многосторонний escrow)',
    'contract.escrowMS2Desc':
      'EscrowMS2 расширяет escrow двумя арбитрами. Средства можно выпустить по одобрению одного арбитра или совместному одобрению обоих.',
    'contract.multipleArbiters':
      'Несколько арбитров: два арбитра могут разрешить выпуск средств.',
    'contract.escrowMS2Spending':
      'Условия расходования: один или оба арбитра предоставляют действительные подписи, а вся сумма поступает покупателю или продавцу.',
    'contract.enhancedTrust':
      'Повышенное доверие: полезно для сделок, требующих нескольких доверенных сторон.',
    'contract.msvault': 'MSVault (мультиподписное хранилище)',
    'contract.msvaultDesc':
      'MSVault создаёт общее или долгосрочное хранилище, требующее нескольких подписей и пароля. Он устанавливает минимальный баланс и блокировку по времени.',
    'contract.multiSignature':
      'Мультиподпись: нужны подписи нескольких уполномоченных сторон.',
    'contract.msvaultSpending':
      'Условия расходования: действительная подпись и подтверждённая паролем подпись данных при сохранении не менее 4000 satoshis либо действительная подпись после окончания блокировки по времени.',
    'contract.msvaultUseCase':
      'Применение: подходит для совместного владения или долгосрочного хранения со строгим контролем доступа.',
    'contract.p2pkh': 'P2PKH (Pay-to-Public-Key-Hash)',
    'contract.p2pkhDesc':
      'P2PKH — стандартный Bitcoin-скрипт, защищающий UTXO требованием подписи владельца указанного хеша открытого ключа.',
    'contract.simplicity':
      'Простота: легко использовать, совместим с большинством Bitcoin-кошельков.',
    'contract.p2pkhSpending':
      'Условия расходования: действительная подпись, соответствующая хешу открытого ключа в контракте.',
    'contract.p2pkhSecurity':
      'Безопасность: проверенный и надёжный способ защиты цифровых активов.',
    'contract.transfer': 'TransferWithTimeout',
    'contract.transferDesc':
      'TransferWithTimeout поддерживает условные переводы с крайним сроком. Получатель может получить средства до срока, а после него отправитель может вернуть их.',
    'contract.timeControl':
      'Контроль времени: задаёт срок, до которого получатель может получить средства.',
    'contract.transferSpending':
      'Условия расходования: получатель подписывает до срока; после него отправитель может вернуть средства действительной подписью.',
    'contract.transferUseCase':
      'Применение: полезно для подписок, условных платежей и сценариев, похожих на escrow.',
    'contract.howToUse': 'Как использовать covenant-контракты',
    'contract.howToUseText':
      'Откройте раздел «Контракты», выберите тип, настройте условия и разверните контракт. Чтобы потратить UTXO контракта, выполните соответствующие условия расходования выше. Подробные инструкции и примеры доступны в документации приложения.',
  },
  'ha-NG': {
    'contractView.title': 'Kwangiloli',
    'contractView.create': 'Ƙirƙiri kwangila',
    'contractView.howWorks': 'Yadda yake aiki',
    'contractView.pickTemplate': '1. Zaɓi samfurin',
    'contractView.fillInputs': '2. Cika abubuwan shigar da constructor',
    'contractView.createStep': '3. Ƙirƙiri kwangilar',
    'contractView.selectContract': 'Zaɓi kwangila',
    'contractView.instantiated': 'Kwangilolin da aka ƙirƙira',
    'contractView.address': 'Adireshi',
    'contractView.tokenAddress': 'Adireshin token',
    'contractView.balance': 'Ma’auni',
    'contractView.noInstances': 'Babu kwangila da aka ƙirƙira tukuna.',
    'contractView.delete': 'Share',
    'contractView.update': 'Sabunta',
    'contractView.back': 'Koma',
    'contractView.constructorArgs': 'Muhawarar constructor',
    'contractView.fillRequired':
      'Cika kowace darajar da ake buƙata kafin ƙirƙirar kwangila.',
    'contractView.blockHeight': 'Tsayin block na yanzu',
    'contractView.blockHeightInfo':
      'Blocks suna ƙaruwa a matsakaicin tazarar mintuna 10.',
    'contractView.unavailable': 'Ba ya samuwa',
    'contractView.noInputs':
      'Wannan samfurin kwangila ba shi da abubuwan shigar constructor.',
    'contractView.datasigInfo': 'Bayanan sa hannun data',
    'contractView.enterMessage': 'Shigar da saƙo don {name}',
    'contractView.selectAddress': 'Zaɓi adireshi',
    'contractView.scanQr': 'Duba QR code na {name}',
    'contractView.signMessage': 'Sa hannu kan saƙo',
    'contractView.signingAddress': 'Adireshin sa hannu',
    'contractView.signature': 'Sa hannu',
    'contractView.argumentTypeInfo': 'Bayanan nau’in argument',
    'contractView.publicKeyInfo':
      'Public key a hex. Yi amfani da “Zaɓi adireshi” don cikawa kai tsaye.',
    'contractView.hashInfo':
      'Hash na bytes 20 (hex) na adireshi/public key. Yi amfani da “Zaɓi adireshi”.',
    'contractView.enterType': 'Shigar da darajar da ta dace da nau’in: {type}.',
    'contractView.selected': 'An zaɓi {type}',
    'contractView.error': 'Kuskure',
    'contractView.addressCopied': 'An kwafi adireshi zuwa clipboard!',
    'contractView.copyFailed': 'An kasa kwafin adireshi.',
    'contractView.selectData':
      'Da fatan zaɓi adireshi ka shigar da data don sa hannu.',
    'contractView.signatureGenerated': 'An samar da sa hannu cikin nasara!',
    'contractView.signatureFailed': 'An kasa samar da sa hannu.',
    'contractView.noQr': 'Ba a gano QR code ba. Sake gwadawa.',
    'contractView.created': 'An ƙirƙiri kwangila cikin nasara!',
    'contractView.deleted': 'An share kwangila cikin nasara!',
    'contractView.deleteFailed': 'An kasa share kwangila.',
    'contractView.updated': 'An sabunta kwangila cikin nasara!',
    'contractView.updateFailed': 'An kasa sabunta kwangila.',
    'contractView.loadContractsFailed':
      'An kasa loda kwangilolin da ke samuwa.',
    'contractView.loadInstancesFailed':
      'An kasa loda kwangilolin da aka ƙirƙira.',
    'contractView.loadDetailsFailed': 'An kasa loda bayanan kwangila.',
    'contractView.createFailed': 'An kasa ƙirƙirar kwangila: {message}',
    'contractView.deleteFailedFallback': 'An kasa share kwangila.',
    'contractView.updateFailedFallback': 'An kasa sabunta kwangila.',
    'contractView.unknownError': 'Kuskuren da ba a sani ba',
    'contractView.privateKeyUnavailable':
      'Private key ba ya samuwa ga wannan adireshin.',
    'contractView.errorPrefix': 'Kuskure: {message}',
    'contract.intro':
      'Covenant contracts a OPTN Wallet smart contracts ne da ke tilasta dokokin kashe kadarorin dijital. Kowace kwangila tana kulle kuɗi a UTXO, kuma za a iya kashe su ne kawai idan an cika sharuɗɗan da aka riga aka tsara.',
    'contract.available': 'Kwangilolin da ke samuwa',
    'contract.bip38': 'BIP38 (Private keys masu kariyar kalmar sirri)',
    'contract.bip38Desc':
      'Kwangilar BIP38 tana kare private keys da kalmar sirri. UTXO ɗinta na buƙatar kalmar sirri madaidaiciya da sa hannu mai inganci.',
    'contract.passwordProtection':
      'Kariyar kalmar sirri: tana ɓoye private key da kalmar sirrin da mai amfani ya saita.',
    'contract.bip38Spending':
      'Sharuɗɗan kashewa: samar da sa hannun mai shi mai inganci da sa hannun data da ke tabbatar da kalmar sirri.',
    'contract.bip38UseCase':
      'Amfani: ya dace don kare private keys daga sata ko shiga ba tare da izini ba, musamman wajen dogon ajiya.',
    'contract.escrow': 'Escrow',
    'contract.escrowDesc':
      'Kwangilar Escrow tana taimakawa amintaccen ciniki tsakanin mai siya da mai sayarwa tare da amintaccen arbiter. Ana sakin kuɗi ne kawai da amincewar arbiter.',
    'contract.arbiter':
      'Arbiter: amintaccen ɓangare da ke ba da izinin sakin kuɗi.',
    'contract.escrowSpending':
      'Sharuɗɗan kashewa: arbiter yana samar da sa hannu mai inganci, kuma dukan adadin yana zuwa adireshin public-key-hash na mai siya ko mai sayarwa.',
    'contract.escrowSecurity':
      'Tsaro: kuɗi suna nan a kulle har sai arbiter ya amince, wanda ke taimakawa hana zamba ko jayayya.',
    'contract.escrowMS2': 'EscrowMS2 (Escrow na ɓangarori da yawa)',
    'contract.escrowMS2Desc':
      'EscrowMS2 yana faɗaɗa escrow da arbiter biyu. Ana iya sakin kuɗi da amincewar arbiter ɗaya ko amincewar su biyun tare.',
    'contract.multipleArbiters':
      'Arbiters da yawa: arbiter biyu na iya ba da izinin sakin kuɗi.',
    'contract.escrowMS2Spending':
      'Sharuɗɗan kashewa: arbiter ɗaya ko su biyun suna samar da sa hannu mai inganci, kuma dukan adadin yana zuwa mai siya ko mai sayarwa.',
    'contract.enhancedTrust':
      'Ƙarin amincewa: ya dace da cinikin da ke buƙatar ɓangarori amintattu da yawa.',
    'contract.msvault': 'MSVault (Vault mai sa hannu da yawa)',
    'contract.msvaultDesc':
      'MSVault yana ƙirƙirar vault na haɗin gwiwa ko dogon lokaci da ke buƙatar sa hannu da yawa da kalmar sirri. Yana tilasta ƙaramin ma’auni da kulle na lokaci.',
    'contract.multiSignature':
      'Sa hannu da yawa: yana buƙatar sa hannun ɓangarori masu izini da yawa.',
    'contract.msvaultSpending':
      'Sharuɗɗan kashewa: samar da sa hannu mai inganci da sa hannun data da kalmar sirri ta tabbatar, kana riƙe aƙalla satoshis 4000, ko amfani da ingantaccen sa hannu bayan kulle na lokaci ya ƙare.',
    'contract.msvaultUseCase':
      'Amfani: ya dace da mallakar haɗin gwiwa ko dogon ajiya mai tsauraran ikon shiga.',
    'contract.p2pkh': 'P2PKH (Pay-to-Public-Key-Hash)',
    'contract.p2pkhDesc':
      'P2PKH Bitcoin script ne na yau da kullum da ke kare UTXO ta hanyar buƙatar sa hannun mai hash na public key da aka nuna.',
    'contract.simplicity':
      'Sauƙi: mai sauƙin amfani kuma ya dace da yawancin Bitcoin wallets.',
    'contract.p2pkhSpending':
      'Sharuɗɗan kashewa: samar da sa hannu mai inganci da ya dace da public-key-hash na kwangila.',
    'contract.p2pkhSecurity':
      'Tsaro: ingantacciyar hanya mai aminci don kare kadarorin dijital.',
    'contract.transfer': 'TransferWithTimeout',
    'contract.transferDesc':
      'TransferWithTimeout yana ba da damar canja wuri mai sharaɗi tare da wa’adi. Mai karɓa zai iya karɓar kuɗi kafin wa’adin; daga baya mai aikawa zai iya dawo da su.',
    'contract.timeControl':
      'Ikon lokaci: yana saita wa’adin da mai karɓa zai karɓi kuɗi.',
    'contract.transferSpending':
      'Sharuɗɗan kashewa: mai karɓa ya sa hannu kafin wa’adi; daga baya mai aikawa zai iya dawo da kuɗi da sa hannu mai inganci.',
    'contract.transferUseCase':
      'Amfani: yana da amfani ga biyan kuɗin rajista, biyan kuɗi mai sharaɗi ko yanayin kama da escrow.',
    'contract.howToUse': 'Yadda ake amfani da covenant contracts',
    'contract.howToUseText':
      'Buɗe sashen Kwangiloli, zaɓi nau’in kwangila, tsara sharuɗɗanta sannan ka tura ta. Don kashe daga UTXO na kwangila, cika takamaiman sharuɗɗan kashewa da ke sama. Ana samun cikakkun umarni da misalai a takardun manhaja.',
  },
};

import type { BaseLocale, SupportedLocale } from './types';

type AddedLocale = Exclude<SupportedLocale, BaseLocale>;

/** Operational, informational, and recovery-adjacent first-party surfaces. */
export const localeOperationalOverrides: Partial<
  Record<AddedLocale, Record<string, string>>
> = {
  'pt-BR': {
    'about.overview': 'Visão geral',
    'about.overviewText':
      'O aplicativo OPTN Wallet oferece controle direto e segurança sobre seus ativos digitais. Os covenants do Bitcoin permitem definir regras personalizadas para gastar fundos.',
    'about.keyFeatures': 'Principais recursos',
    'about.creating': 'Criar e importar carteiras',
    'about.creatingText':
      'Crie novas carteiras ou importe carteiras existentes usando formatos padrão compatíveis com outras carteiras Bitcoin.',
    'about.viewing': 'Visualizar covenants',
    'about.viewingText':
      'Revise as regras que controlam as transações para entender como seus fundos são protegidos.',
    'about.building': 'Criar e enviar transações',
    'about.buildingText':
      'Construa transações com condições de covenant personalizadas, como bloqueios de tempo, requisitos de múltiplas assinaturas ou endereços permitidos.',
    'about.security': 'Segurança',
    'about.securityText':
      'Os recursos de covenant do Bitcoin ajudam a proteger ativos contra transações não autorizadas.',
    'about.why': 'Por que escolher o OPTN Wallet?',
    'about.unmatched': 'Segurança incomparável',
    'about.unmatchedText':
      'Defina exatamente como os fundos podem ser gastos com covenants Bitcoin.',
    'about.flexibility': 'Flexibilidade',
    'about.flexibilityText':
      'Adapte sua experiência com condições de transação personalizadas.',
    'about.intuitive': 'Design intuitivo',
    'about.intuitiveText':
      'Uma interface amigável que torna a gestão de ativos acessível para iniciantes.',
    'about.community': 'Feedback da comunidade',
    'about.communityText':
      'Criado com a contribuição de testadores beta e necessidades reais de usuários.',
    'about.intended': 'Uso previsto',
    'about.intendedText':
      'O OPTN ajuda você a gerenciar ativos digitais com recursos avançados de covenant, seja para fundos pessoais ou para explorar covenants Bitcoin.',
    'about.learn': 'Saiba mais sobre covenants Bitcoin',
    'about.learnText':
      'Explore estes recursos para aprofundar seu conhecimento sobre covenants Bitcoin:',
    'about.wiki': 'Wiki de covenants Bitcoin',
    'about.cashscriptGuide': 'CashScript — escrever covenants e introspecção',
    'about.cashscriptExamples': 'Exemplos de covenants CashScript',
    'about.cointelegraph':
      'Cointelegraph — O que são covenants Bitcoin e como funcionam?',
    'about.feedback': 'Feedback e suporte',
    'about.feedbackText':
      'Seu feedback nos ajuda a melhorar o OPTN Wallet. Para sugestões, problemas ou suporte, entre em contato conosco em',
    'terms.acceptance': '1. Aceitação dos termos',
    'terms.acceptanceText':
      'Ao acessar e usar o aplicativo OPTN Wallet (“o Aplicativo”), você concorda em cumprir estes Termos de Uso. Se não concordar, não use o Aplicativo.',
    'terms.purpose': '2. Finalidade',
    'terms.purposeText':
      'O aplicativo OPTN Wallet permite armazenar, enviar e receber criptomoedas com segurança. Você é responsável pela segurança de suas chaves privadas e ativos.',
    'terms.responsibilities': '3. Responsabilidades do usuário',
    'terms.responsibilitiesIntro':
      'O aplicativo OPTN Wallet lida com criptomoedas reais. Você é o único responsável por:',
    'terms.safeguard': 'Proteger suas chaves privadas e frases de recuperação.',
    'terms.verify':
      'Verificar os detalhes das transações antes de confirmar qualquer ação.',
    'terms.deviceSecurity':
      'Garantir a segurança do seu dispositivo e do Aplicativo.',
    'terms.responsibilitiesText':
      'A equipe de desenvolvimento não se responsabiliza por perda de ativos ou acesso não autorizado resultante do descumprimento dessas práticas.',
    'terms.noLiability': '4. Ausência de responsabilidade',
    'terms.noLiabilityText':
      'Os desenvolvedores não assumem responsabilidade por perda, dano ou acesso não autorizado decorrente do uso do Aplicativo, incluindo perda de criptomoedas, violações de dados ou falhas do dispositivo. Você usa o Aplicativo por sua conta e risco.',
    'terms.noWarranty': '5. Ausência de garantia',
    'terms.noWarrantyText':
      'O Aplicativo é fornecido “como está”, sem garantias expressas ou implícitas. Os desenvolvedores não garantem confiabilidade, precisão, integralidade, operação sem erros ou serviço ininterrupto.',
    'terms.modifications': '6. Alterações',
    'terms.modificationsText':
      'Os desenvolvedores podem modificar, suspender ou descontinuar o Aplicativo sem aviso prévio e podem atualizar estes Termos. Você é responsável por revisá-los periodicamente.',
    'paper.title': 'Carteira de papel',
    'paper.description':
      'Escaneie uma carteira de papel WIF e transfira BCH + CashTokens em uma transação.',
    'paper.label': 'Carteira de papel',
    'paper.notScanned': 'Nenhuma carteira de papel escaneada ainda.',
    'paper.scan': 'Escanear',
    'paper.sweep': 'Transferir',
    'paper.utxosTitle': 'UTXOs da carteira de papel',
    'paper.spendableOutputSingular': 'saída disponível',
    'paper.spendableOutputPlural': 'saídas disponíveis',
    'paper.tokenGroups': 'Grupos de tokens',
    'paper.noCashTokens': 'Nenhum CashToken detectado.',
    'paper.back': 'Voltar',
    'paper.confirmTitle': 'Confirmar transferência',
    'paper.confirmDescription':
      'Deslize para confirmar a transferência da carteira de papel em uma transação.',
    'paper.paperInputs': 'Entradas da carteira de papel',
    'paper.walletFeeInputs': 'Entradas de taxa da carteira',
    'paper.tokenOutputs': 'Saídas de tokens',
    'paper.bchOutputs': 'Saídas BCH',
    'paper.oneTransaction': 'Apenas uma transação.',
    'paper.tokenBacking': 'As saídas de tokens são respaldadas com 1000 sats.',
    'paper.noQrCode': 'Nenhum código QR detectado. Tente novamente.',
    'paper.addressDerivationFailed':
      'Não foi possível derivar um endereço válido da carteira de papel a partir da chave escaneada.',
    'paper.noUtxos':
      'Nenhum UTXO encontrado para esta carteira de papel. Se for uma carteira mainnet e você estiver no chipnet, tente trocar de rede.',
    'paper.scanBeforeSweep':
      'Escaneie uma carteira de papel antes de transferir.',
    'paper.noDestination': 'Nenhum endereço de carteira de destino disponível.',
    'paper.buildFailed': 'Falha ao criar a transação de transferência.',
    'paper.sweepBroadcast': 'Transferência transmitida',
    'paper.decodingError': 'Erro de decodificação',
    'paper.addressConversionError': 'Erro de conversão de endereço',
    'paper.unexpected': 'Ocorreu um erro inesperado.',
    'paper.unexpectedTryAgain': 'Ocorreu um erro inesperado. Tente novamente.',
    'faucet.name': 'Faucet do Chipnet',
    'faucet.tooltip': 'Obter BCH do Chipnet',
    'faucet.instructions': 'Instruções',
    'faucet.copyAddress': 'Copie um endereço BCH do Chipnet',
    'faucet.clickLink': 'Clique no link do Faucet do Chipnet',
    'faucet.selectNetwork': 'Selecione “chipnet” na caixa NETWORK',
    'faucet.pasteAddress': 'Cole seu endereço',
    'faucet.captcha': 'Responda à pergunta do captcha',
    'faucet.getCoins': 'Pressione “Get Coins”',
    'watchOnly.title': 'Prévia de carteira somente leitura',
    'watchOnly.description':
      'Inspecione endereços públicos BCH sem importar chaves privadas.',
    'watchOnly.type': 'Tipo de carteira somente leitura',
    'watchOnly.standard': 'Padrão',
    'watchOnly.accountXpub': 'xPub da conta',
    'watchOnly.comingNext': 'Em breve',
    'watchOnly.multisign': 'Multissig',
    'watchOnly.multipleCosigners': 'Vários signatários',
    'watchOnly.network': 'Rede',
    'watchOnly.mainnet': 'Mainnet',
    'watchOnly.chipnet': 'Chipnet',
    'watchOnly.xpubPlaceholder': 'Cole o xPub exportado pelo SeedCash',
    'watchOnly.scanCamera': 'Escanear (câmera)',
    'watchOnly.uploadQr': 'Enviar QR',
    'watchOnly.pathNote':
      'Confirme que o SeedCash exportou esta conta em m/44’/145’/account’. Um xPub BIP32 independente não comprova seu propósito pai ou caminho da moeda.',
    'watchOnly.previewPublic': 'Visualizar endereços públicos',
    'watchOnly.previewTitle': 'Prévia de endereços públicos',
    'watchOnly.receive': 'Receber #{index}',
    'watchOnly.change': 'Troco #{index}',
    'watchOnly.warning':
      'Apenas prévia pública: esta tela ainda não salva uma carteira somente leitura nem cria, assina, importa ou transmite transações PSBT.',
    'watchOnly.back': 'Voltar às carteiras',
    'derivation.invalidActive': 'O caminho de derivação ativo é inválido.',
    'derivation.required': '{field} é obrigatório.',
    'derivation.invalidValues': 'Valores de caminho BIP44 inválidos.',
    'derivation.pathPreview': 'Prévia do caminho',
    'derivation.pathDescription':
      'O caminho fixo da conta BIP44 usado por esta carteira.',
    'derivation.coinType': 'Tipo de moeda',
    'derivation.bip44CoinType': 'Tipo de moeda BIP44',
    'derivation.networkDefault': 'Padrão da rede: {value}',
    'derivation.accountIndex': 'Índice da conta',
    'derivation.bip44AccountIndex': 'Índice da conta BIP44',
    'derivation.usuallyZero': 'Normalmente 0',
    'derivation.branchDescription':
      'Os marcadores hardened são fixos. Os endereços de recebimento e troco são derivados automaticamente dos ramos /0/index e /1/index.',
    'derivation.range': 'Insira números inteiros de 0 a {max}.',
    'derivation.walletNetwork': 'Rede da carteira',
    'derivation.walletNetworkDescription':
      'Escolha se esta carteira se conecta a fundos reais na Mainnet ou a fundos de teste no Chipnet.',
    'derivation.addressDerivation': 'Derivação de endereço',
    'derivation.addressDerivationDescription':
      'Caminho de conta BIP44 usado para derivar esta carteira.',
    'derivation.customize': 'Personalizar',
    'reconfiguration.preparing': 'Preparando carteira',
    'reconfiguration.preparingDetail':
      'Parando a sincronização em segundo plano e reconectando à rede selecionada.',
    'reconfiguration.clearing': 'Limpando dados antigos da carteira',
    'reconfiguration.clearingDetail':
      'Removendo registros anteriores de endereços, histórico e UTXOs.',
    'reconfiguration.deriving': 'Gerando endereços da carteira',
    'reconfiguration.derivingDetail':
      'Criando os endereços de recebimento e troco para este caminho de carteira.',
    'reconfiguration.syncing': 'Sincronizando carteira',
    'reconfiguration.syncingDetail':
      'Buscando saldos, UTXOs e histórico de transações. Isso pode levar de 15 a 20 segundos.',
    'reconfiguration.switchingNetwork': 'Trocando de rede',
    'reconfiguration.changingPath': 'Alterando caminho de derivação',
    'reconfiguration.reloading': 'Recarregando carteira',
    'reconfiguration.updating': 'Atualizando carteira',
    'reconfiguration.movingTo': 'Movendo para {network}',
    'reconfiguration.working': 'Processando…',
    'reconfiguration.stepOf': 'Etapa {current} de {total}',
    'reconfiguration.progress': 'Progresso da atualização da carteira',
    'reconfiguration.failed': 'Falha na atualização da carteira',
    'reconfiguration.failedDetail': 'Não foi possível reconfigurar a carteira.',
    'reconfiguration.dismiss': 'Dispensar',
    'reconfiguration.keepOpen':
      'Mantenha o OPTN Wallet aberto. A navegação está temporariamente desativada enquanto os dados da carteira são recriados.',
  },
  vi: {
    'about.overview': 'Tổng quan',
    'about.overviewText':
      'Ứng dụng OPTN Wallet cho bạn quyền kiểm soát trực tiếp và bảo mật tài sản số. Covenant Bitcoin cho phép đặt quy tắc tùy chỉnh cho việc chi tiêu tiền.',
    'about.keyFeatures': 'Tính năng chính',
    'about.creating': 'Tạo và nhập ví',
    'about.creatingText':
      'Tạo ví mới hoặc nhập ví hiện có bằng các định dạng chuẩn tương thích với ví Bitcoin khác.',
    'about.viewing': 'Xem covenant',
    'about.viewingText':
      'Xem các quy tắc điều khiển giao dịch để hiểu cách tiền của bạn được bảo vệ.',
    'about.building': 'Tạo và gửi giao dịch',
    'about.buildingText':
      'Tạo giao dịch với điều kiện covenant tùy chỉnh như khóa thời gian, yêu cầu nhiều chữ ký hoặc địa chỉ cho phép.',
    'about.security': 'Bảo mật',
    'about.securityText':
      'Tính năng covenant Bitcoin giúp bảo vệ tài sản khỏi giao dịch trái phép.',
    'about.why': 'Vì sao chọn OPTN Wallet?',
    'about.unmatched': 'Bảo mật vượt trội',
    'about.unmatchedText':
      'Xác định chính xác cách tiền có thể được chi tiêu bằng covenant Bitcoin.',
    'about.flexibility': 'Linh hoạt',
    'about.flexibilityText':
      'Tùy chỉnh trải nghiệm ví với điều kiện giao dịch riêng.',
    'about.intuitive': 'Thiết kế trực quan',
    'about.intuitiveText':
      'Giao diện thân thiện giúp người mới dễ quản lý tài sản.',
    'about.community': 'Phản hồi cộng đồng',
    'about.communityText':
      'Được xây dựng với ý kiến của người thử nghiệm beta và nhu cầu thực tế.',
    'about.intended': 'Mục đích sử dụng',
    'about.intendedText':
      'OPTN hỗ trợ quản lý tài sản số với tính năng covenant nâng cao, dù bạn quản lý tiền cá nhân hay tìm hiểu covenant Bitcoin.',
    'about.learn': 'Tìm hiểu thêm về covenant Bitcoin',
    'about.learnText':
      'Khám phá các tài nguyên sau để hiểu sâu hơn về covenant Bitcoin:',
    'about.wiki': 'Wiki Covenant Bitcoin',
    'about.cashscriptGuide': 'CashScript — viết covenant và introspection',
    'about.cashscriptExamples': 'Ví dụ covenant CashScript',
    'about.cointelegraph':
      'Cointelegraph — Covenant Bitcoin là gì và hoạt động thế nào?',
    'about.feedback': 'Phản hồi và hỗ trợ',
    'about.feedbackText':
      'Phản hồi giúp chúng tôi cải thiện OPTN Wallet. Để gửi góp ý, báo lỗi hoặc cần hỗ trợ, hãy liên hệ tại',
    'terms.acceptance': '1. Chấp nhận điều khoản',
    'terms.acceptanceText':
      'Bằng việc truy cập và sử dụng ứng dụng OPTN Wallet (“Ứng dụng”), bạn đồng ý tuân thủ và chịu ràng buộc bởi Điều khoản sử dụng này. Nếu không đồng ý, vui lòng không dùng Ứng dụng.',
    'terms.purpose': '2. Mục đích',
    'terms.purposeText':
      'Ứng dụng OPTN Wallet cho phép lưu trữ, gửi và nhận tiền mã hóa an toàn. Bạn chịu trách nhiệm bảo mật khóa riêng và tài sản của mình.',
    'terms.responsibilities': '3. Trách nhiệm người dùng',
    'terms.responsibilitiesIntro':
      'Ứng dụng OPTN Wallet xử lý tiền mã hóa thật. Bạn hoàn toàn chịu trách nhiệm về:',
    'terms.safeguard': 'Bảo vệ khóa riêng và cụm từ khôi phục.',
    'terms.verify': 'Xác minh chi tiết giao dịch trước khi xác nhận hành động.',
    'terms.deviceSecurity': 'Đảm bảo thiết bị và Ứng dụng được bảo mật.',
    'terms.responsibilitiesText':
      'Đội phát triển không chịu trách nhiệm về mất tài sản hoặc truy cập trái phép do không tuân thủ các thực hành này.',
    'terms.noLiability': '4. Không chịu trách nhiệm',
    'terms.noLiabilityText':
      'Nhà phát triển không chịu trách nhiệm về mất mát, thiệt hại hoặc truy cập trái phép phát sinh từ việc dùng Ứng dụng, bao gồm mất tiền mã hóa, vi phạm dữ liệu hoặc lỗi thiết bị. Bạn tự chịu rủi ro khi sử dụng.',
    'terms.noWarranty': '5. Không bảo hành',
    'terms.noWarrantyText':
      'Ứng dụng được cung cấp “nguyên trạng” không có bảo đảm rõ ràng hay ngụ ý. Nhà phát triển không bảo đảm độ tin cậy, chính xác, đầy đủ, không lỗi hoặc dịch vụ liên tục.',
    'terms.modifications': '6. Thay đổi',
    'terms.modificationsText':
      'Nhà phát triển có thể sửa đổi, tạm dừng hoặc ngừng Ứng dụng mà không báo trước và có thể cập nhật Điều khoản. Bạn có trách nhiệm xem lại định kỳ.',
    'paper.title': 'Ví giấy',
    'paper.description':
      'Quét ví giấy WIF và chuyển BCH + CashTokens trong một giao dịch.',
    'paper.label': 'Ví giấy',
    'paper.notScanned': 'Chưa quét ví giấy nào.',
    'paper.scan': 'Quét',
    'paper.sweep': 'Chuyển',
    'paper.utxosTitle': 'UTXO ví giấy',
    'paper.spendableOutputSingular': 'đầu ra có thể chi',
    'paper.spendableOutputPlural': 'đầu ra có thể chi',
    'paper.tokenGroups': 'Nhóm token',
    'paper.noCashTokens': 'Không phát hiện CashToken.',
    'paper.back': 'Quay lại',
    'paper.confirmTitle': 'Xác nhận chuyển',
    'paper.confirmDescription':
      'Trượt để xác nhận chuyển ví giấy trong một giao dịch.',
    'paper.paperInputs': 'Đầu vào ví giấy',
    'paper.walletFeeInputs': 'Đầu vào phí ví',
    'paper.tokenOutputs': 'Đầu ra token',
    'paper.bchOutputs': 'Đầu ra BCH',
    'paper.oneTransaction': 'Chỉ một giao dịch.',
    'paper.tokenBacking': 'Đầu ra token được bảo chứng bằng 1000 sats.',
    'paper.noQrCode': 'Không phát hiện mã QR. Hãy thử lại.',
    'paper.addressDerivationFailed':
      'Không thể dẫn xuất địa chỉ ví giấy hợp lệ từ khóa đã quét.',
    'paper.noUtxos':
      'Không tìm thấy UTXO cho ví giấy này. Nếu là ví mainnet nhưng bạn đang ở chipnet, hãy đổi mạng.',
    'paper.scanBeforeSweep': 'Hãy quét ví giấy trước khi chuyển.',
    'paper.noDestination': 'Không có địa chỉ ví đích.',
    'paper.buildFailed': 'Tạo giao dịch chuyển thất bại.',
    'paper.sweepBroadcast': 'Đã phát giao dịch chuyển',
    'paper.decodingError': 'Lỗi giải mã',
    'paper.addressConversionError': 'Lỗi chuyển đổi địa chỉ',
    'paper.unexpected': 'Đã xảy ra lỗi không mong muốn.',
    'paper.unexpectedTryAgain': 'Đã xảy ra lỗi không mong muốn. Hãy thử lại.',
    'faucet.name': 'Faucet Chipnet',
    'faucet.tooltip': 'Nhận BCH Chipnet',
    'faucet.instructions': 'Hướng dẫn',
    'faucet.copyAddress': 'Sao chép địa chỉ BCH Chipnet',
    'faucet.clickLink': 'Nhấp liên kết Faucet Chipnet',
    'faucet.selectNetwork': 'Chọn “chipnet” trong ô NETWORK',
    'faucet.pasteAddress': 'Dán địa chỉ của bạn',
    'faucet.captcha': 'Trả lời câu hỏi captcha',
    'faucet.getCoins': 'Nhấn “Get Coins”',
    'watchOnly.title': 'Xem trước ví chỉ theo dõi',
    'watchOnly.description':
      'Kiểm tra địa chỉ BCH công khai mà không nhập khóa riêng.',
    'watchOnly.type': 'Loại ví chỉ theo dõi',
    'watchOnly.standard': 'Tiêu chuẩn',
    'watchOnly.accountXpub': 'xPub tài khoản',
    'watchOnly.comingNext': 'Sắp có',
    'watchOnly.multisign': 'Đa chữ ký',
    'watchOnly.multipleCosigners': 'Nhiều người đồng ký',
    'watchOnly.network': 'Mạng',
    'watchOnly.mainnet': 'Mainnet',
    'watchOnly.chipnet': 'Chipnet',
    'watchOnly.xpubPlaceholder': 'Dán xPub do SeedCash xuất',
    'watchOnly.scanCamera': 'Quét (camera)',
    'watchOnly.uploadQr': 'Tải QR lên',
    'watchOnly.pathNote':
      'Xác nhận SeedCash đã xuất tài khoản này tại m/44’/145’/account’. xPub BIP32 độc lập không chứng minh được mục đích cha hoặc đường dẫn coin.',
    'watchOnly.previewPublic': 'Xem trước địa chỉ công khai',
    'watchOnly.previewTitle': 'Xem trước địa chỉ công khai',
    'watchOnly.receive': 'Nhận #{index}',
    'watchOnly.change': 'Tiền thừa #{index}',
    'watchOnly.warning':
      'Chỉ xem công khai: màn hình này chưa lưu ví chỉ theo dõi hoặc tạo, ký, nhập hay phát giao dịch PSBT.',
    'watchOnly.back': 'Quay lại ví',
    'derivation.invalidActive':
      'Đường dẫn dẫn xuất đang hoạt động không hợp lệ.',
    'derivation.required': '{field} là bắt buộc.',
    'derivation.invalidValues': 'Giá trị đường dẫn BIP44 không hợp lệ.',
    'derivation.pathPreview': 'Xem trước đường dẫn',
    'derivation.pathDescription':
      'Đường dẫn tài khoản BIP44 cố định mà ví này sử dụng.',
    'derivation.coinType': 'Loại coin',
    'derivation.bip44CoinType': 'Loại coin BIP44',
    'derivation.networkDefault': 'Mặc định mạng: {value}',
    'derivation.accountIndex': 'Chỉ mục tài khoản',
    'derivation.bip44AccountIndex': 'Chỉ mục tài khoản BIP44',
    'derivation.usuallyZero': 'Thường là 0',
    'derivation.branchDescription':
      'Dấu hardened là cố định. Địa chỉ nhận và tiền thừa được dẫn xuất tự động từ nhánh /0/index và /1/index.',
    'derivation.range': 'Nhập số nguyên từ 0 đến {max}.',
    'derivation.walletNetwork': 'Mạng ví',
    'derivation.walletNetworkDescription':
      'Chọn ví kết nối với tiền thật trên Mainnet hay tiền thử nghiệm trên Chipnet.',
    'derivation.addressDerivation': 'Dẫn xuất địa chỉ',
    'derivation.addressDerivationDescription':
      'Đường dẫn tài khoản BIP44 dùng để dẫn xuất ví này.',
    'derivation.customize': 'Tùy chỉnh',
    'reconfiguration.preparing': 'Đang chuẩn bị ví',
    'reconfiguration.preparingDetail':
      'Dừng đồng bộ nền và kết nối lại với mạng đã chọn.',
    'reconfiguration.clearing': 'Đang xóa dữ liệu ví cũ',
    'reconfiguration.clearingDetail':
      'Xóa bản ghi địa chỉ, lịch sử và UTXO trước đó.',
    'reconfiguration.deriving': 'Đang tạo địa chỉ ví',
    'reconfiguration.derivingDetail':
      'Tạo địa chỉ nhận và tiền thừa cho đường dẫn ví này.',
    'reconfiguration.syncing': 'Đang đồng bộ ví',
    'reconfiguration.syncingDetail':
      'Đang lấy số dư, UTXO và lịch sử giao dịch. Có thể mất 15–20 giây.',
    'reconfiguration.switchingNetwork': 'Đang đổi mạng',
    'reconfiguration.changingPath': 'Đang đổi đường dẫn dẫn xuất',
    'reconfiguration.reloading': 'Đang tải lại ví',
    'reconfiguration.updating': 'Đang cập nhật ví',
    'reconfiguration.movingTo': 'Đang chuyển sang {network}',
    'reconfiguration.working': 'Đang xử lý…',
    'reconfiguration.stepOf': 'Bước {current}/{total}',
    'reconfiguration.progress': 'Tiến trình cập nhật ví',
    'reconfiguration.failed': 'Cập nhật ví thất bại',
    'reconfiguration.failedDetail': 'Không thể cấu hình lại ví.',
    'reconfiguration.dismiss': 'Bỏ qua',
    'reconfiguration.keepOpen':
      'Hãy giữ OPTN Wallet mở. Điều hướng tạm thời bị vô hiệu hóa khi dữ liệu ví được dựng lại.',
  },
  'zh-TW': {
    'about.overview': '概覽',
    'about.overviewText':
      'OPTN Wallet 應用程式讓您直接控制並保護數位資產。Bitcoin covenant 可自訂資金支出的規則，讓錢包符合您的偏好。',
    'about.keyFeatures': '主要功能',
    'about.creating': '建立與匯入錢包',
    'about.creatingText':
      '使用與其他 Bitcoin 錢包相容的標準格式建立新錢包或匯入現有錢包。',
    'about.viewing': '檢視 Covenant',
    'about.viewingText': '檢查控制交易的規則，了解資金如何受到保護。',
    'about.building': '建立與傳送交易',
    'about.buildingText':
      '使用時間鎖、多重簽署要求或允許清單地址等自訂 covenant 條件建立交易。',
    'about.security': '安全性',
    'about.securityText': 'Bitcoin covenant 功能有助於保護資產免於未授權交易。',
    'about.why': '為什麼選擇 OPTN Wallet？',
    'about.unmatched': '無與倫比的安全性',
    'about.unmatchedText': '使用 Bitcoin covenant 精確定義資金可如何支出。',
    'about.flexibility': '彈性',
    'about.flexibilityText': '使用自訂交易條件調整錢包體驗。',
    'about.intuitive': '直覺設計',
    'about.intuitiveText': '友善介面讓初學者也能輕鬆管理資產。',
    'about.community': '社群回饋',
    'about.communityText': '根據 beta 測試者意見與真實使用者需求打造。',
    'about.intended': '預定用途',
    'about.intendedText':
      '無論您管理個人資金或探索 Bitcoin covenant，OPTN 都能以進階 covenant 功能協助管理數位資產。',
    'about.learn': '深入了解 Bitcoin covenant',
    'about.learnText': '探索以下資源以深入了解 Bitcoin covenant：',
    'about.wiki': 'Bitcoin Covenant Wiki',
    'about.cashscriptGuide': 'CashScript — 撰寫 Covenant 與 introspection',
    'about.cashscriptExamples': 'CashScript Covenant 範例',
    'about.cointelegraph':
      'Cointelegraph — Bitcoin covenant 是什麼，如何運作？',
    'about.feedback': '回饋與支援',
    'about.feedbackText':
      '您的回饋有助於我們改進 OPTN Wallet。如有建議、問題或需要支援，請聯絡我們：',
    'terms.acceptance': '1. 接受條款',
    'terms.acceptanceText':
      '存取與使用 OPTN Wallet 應用程式（「本應用程式」）即表示您同意遵守並受這些使用條款約束。若不同意，請勿使用本應用程式。',
    'terms.purpose': '2. 目的',
    'terms.purposeText':
      'OPTN Wallet 應用程式讓使用者安全地儲存、傳送與接收加密貨幣。您必須負責私密金鑰與資產的安全。',
    'terms.responsibilities': '3. 使用者責任',
    'terms.responsibilitiesIntro':
      'OPTN Wallet 應用程式處理真實加密貨幣。您對以下事項負完全責任：',
    'terms.safeguard': '保護您的私密金鑰與復原片語。',
    'terms.verify': '確認任何操作前驗證交易詳細資料。',
    'terms.deviceSecurity': '確保裝置與應用程式安全。',
    'terms.responsibilitiesText':
      '若未遵循這些做法而導致資產損失或未授權存取，開發團隊不負責任。',
    'terms.noLiability': '4. 不負責任',
    'terms.noLiabilityText':
      '開發者不對使用本應用程式造成的損失、損害或未授權存取負責，包括加密貨幣損失、資料外洩或裝置故障。您須自行承擔使用風險。',
    'terms.noWarranty': '5. 不提供保證',
    'terms.noWarrantyText':
      '本應用程式按「現狀」提供，不提供明示或默示保證。開發者不保證可靠性、準確性、完整性、無錯誤運作或不中斷服務。',
    'terms.modifications': '6. 修改',
    'terms.modificationsText':
      '開發者可在不事先通知的情況下修改、暫停或終止本應用程式，也可更新這些條款。您必須定期查看條款。',
    'paper.title': '紙錢包',
    'paper.description': '掃描 WIF 紙錢包，透過一筆交易轉移 BCH + CashTokens。',
    'paper.label': '紙錢包',
    'paper.notScanned': '尚未掃描紙錢包。',
    'paper.scan': '掃描',
    'paper.sweep': '轉移',
    'paper.utxosTitle': '紙錢包 UTXO',
    'paper.spendableOutputSingular': '可支出輸出',
    'paper.spendableOutputPlural': '可支出輸出',
    'paper.tokenGroups': '代幣群組',
    'paper.noCashTokens': '未偵測到 CashToken。',
    'paper.back': '返回',
    'paper.confirmTitle': '確認轉移',
    'paper.confirmDescription': '滑動以確認以單筆交易轉移紙錢包。',
    'paper.paperInputs': '紙錢包輸入',
    'paper.walletFeeInputs': '錢包費用輸入',
    'paper.tokenOutputs': '代幣輸出',
    'paper.bchOutputs': 'BCH 輸出',
    'paper.oneTransaction': '僅限一筆交易。',
    'paper.tokenBacking': '代幣輸出以 1000 sats 作為支撐。',
    'paper.noQrCode': '未偵測到 QR 碼。請再試一次。',
    'paper.addressDerivationFailed': '無法從掃描的金鑰導出有效紙錢包地址。',
    'paper.noUtxos':
      '找不到此紙錢包的 UTXO。若這是 mainnet 錢包但您位於 chipnet，請嘗試切換網路。',
    'paper.scanBeforeSweep': '請先掃描紙錢包再進行轉移。',
    'paper.noDestination': '沒有可用的目的錢包地址。',
    'paper.buildFailed': '建立轉移交易失敗。',
    'paper.sweepBroadcast': '轉移已廣播',
    'paper.decodingError': '解碼錯誤',
    'paper.addressConversionError': '地址轉換錯誤',
    'paper.unexpected': '發生未預期的錯誤。',
    'paper.unexpectedTryAgain': '發生未預期的錯誤。請再試一次。',
    'faucet.name': 'Chipnet Faucet',
    'faucet.tooltip': '取得 Chipnet BCH',
    'faucet.instructions': '說明',
    'faucet.copyAddress': '複製 BCH Chipnet 地址',
    'faucet.clickLink': '點擊 Chipnet Faucet 連結',
    'faucet.selectNetwork': '在 NETWORK 方塊中選取「chipnet」',
    'faucet.pasteAddress': '貼上您的地址',
    'faucet.captcha': '回答 captcha 問題',
    'faucet.getCoins': '按下「Get Coins」',
    'watchOnly.title': '唯讀錢包預覽',
    'watchOnly.description': '不匯入任何私密金鑰即可檢視公開 BCH 地址。',
    'watchOnly.type': '唯讀錢包類型',
    'watchOnly.standard': '標準',
    'watchOnly.accountXpub': '帳戶 xPub',
    'watchOnly.comingNext': '即將推出',
    'watchOnly.multisign': '多重簽署',
    'watchOnly.multipleCosigners': '多位共同簽署者',
    'watchOnly.network': '網路',
    'watchOnly.mainnet': 'Mainnet',
    'watchOnly.chipnet': 'Chipnet',
    'watchOnly.xpubPlaceholder': '貼上 SeedCash 匯出的 xPub',
    'watchOnly.scanCamera': '掃描（相機）',
    'watchOnly.uploadQr': '上傳 QR',
    'watchOnly.pathNote':
      '確認 SeedCash 將此帳戶匯出至 m/44’/145’/account’。獨立的 BIP32 xPub 無法證明父目的或 coin 路徑。',
    'watchOnly.previewPublic': '預覽公開地址',
    'watchOnly.previewTitle': '公開地址預覽',
    'watchOnly.receive': '接收 #{index}',
    'watchOnly.change': '找零 #{index}',
    'watchOnly.warning':
      '僅限公開預覽：此畫面尚未儲存唯讀錢包，也不會建立、簽署、匯入或廣播 PSBT 交易。',
    'watchOnly.back': '返回錢包',
    'derivation.invalidActive': '作用中的衍生路徑無效。',
    'derivation.required': '{field} 為必填。',
    'derivation.invalidValues': 'BIP44 路徑值無效。',
    'derivation.pathPreview': '路徑預覽',
    'derivation.pathDescription': '此錢包使用的固定 BIP44 帳戶路徑。',
    'derivation.coinType': 'Coin 類型',
    'derivation.bip44CoinType': 'BIP44 coin 類型',
    'derivation.networkDefault': '網路預設值：{value}',
    'derivation.accountIndex': '帳戶索引',
    'derivation.bip44AccountIndex': 'BIP44 帳戶索引',
    'derivation.usuallyZero': '通常為 0',
    'derivation.branchDescription':
      'Hardened 標記固定。接收與找零地址會從 /0/index 與 /1/index 分支自動導出。',
    'derivation.range': '輸入 0 到 {max} 的整數。',
    'derivation.walletNetwork': '錢包網路',
    'derivation.walletNetworkDescription':
      '選擇此錢包連線至 Mainnet 的真實資金或 Chipnet 的測試資金。',
    'derivation.addressDerivation': '地址衍生',
    'derivation.addressDerivationDescription':
      '用來衍生此錢包的 BIP44 帳戶路徑。',
    'derivation.customize': '自訂',
    'reconfiguration.preparing': '正在準備錢包',
    'reconfiguration.preparingDetail': '正在停止背景同步並重新連線至所選網路。',
    'reconfiguration.clearing': '正在清除舊錢包資料',
    'reconfiguration.clearingDetail':
      '正在移除先前的地址、歷史記錄與 UTXO 記錄。',
    'reconfiguration.deriving': '正在產生錢包地址',
    'reconfiguration.derivingDetail': '正在為此錢包路徑建立接收與找零地址。',
    'reconfiguration.syncing': '正在同步錢包',
    'reconfiguration.syncingDetail':
      '正在取得餘額、UTXO 與交易歷史。可能需要 15–20 秒。',
    'reconfiguration.switchingNetwork': '正在切換網路',
    'reconfiguration.changingPath': '正在變更衍生路徑',
    'reconfiguration.reloading': '正在重新載入錢包',
    'reconfiguration.updating': '正在更新錢包',
    'reconfiguration.movingTo': '正在移至 {network}',
    'reconfiguration.working': '處理中…',
    'reconfiguration.stepOf': '第 {current}/{total} 步',
    'reconfiguration.progress': '錢包更新進度',
    'reconfiguration.failed': '錢包更新失敗',
    'reconfiguration.failedDetail': '無法重新設定錢包。',
    'reconfiguration.dismiss': '關閉',
    'reconfiguration.keepOpen':
      '請保持 OPTN Wallet 開啟。重新建立錢包資料時會暫時停用導覽。',
  },
  fr: {
    'about.overview': 'Vue d’ensemble',
    'about.overviewText':
      'L’application OPTN Wallet vous donne un contrôle direct et sécurisé de vos actifs numériques. Les covenants Bitcoin permettent de définir des règles personnalisées pour dépenser les fonds.',
    'about.keyFeatures': 'Fonctionnalités principales',
    'about.creating': 'Créer et importer des portefeuilles',
    'about.creatingText':
      'Créez de nouveaux portefeuilles ou importez-en à l’aide de formats standards compatibles avec d’autres portefeuilles Bitcoin.',
    'about.viewing': 'Afficher les covenants',
    'about.viewingText':
      'Examinez les règles qui régissent les transactions pour comprendre comment vos fonds sont protégés.',
    'about.building': 'Créer et envoyer des transactions',
    'about.buildingText':
      'Construisez des transactions avec des conditions de covenant personnalisées : verrous temporels, signatures multiples ou adresses autorisées.',
    'about.security': 'Sécurité',
    'about.securityText':
      'Les covenants Bitcoin contribuent à protéger les actifs contre les transactions non autorisées.',
    'about.why': 'Pourquoi choisir OPTN Wallet ?',
    'about.unmatched': 'Sécurité inégalée',
    'about.unmatchedText':
      'Définissez précisément comment les fonds peuvent être dépensés avec les covenants Bitcoin.',
    'about.flexibility': 'Flexibilité',
    'about.flexibilityText':
      'Adaptez votre expérience avec des conditions de transaction personnalisées.',
    'about.intuitive': 'Design intuitif',
    'about.intuitiveText':
      'Une interface conviviale qui rend la gestion des actifs accessible aux débutants.',
    'about.community': 'Retour de la communauté',
    'about.communityText':
      'Conçu avec les retours de testeurs bêta et les besoins réels des utilisateurs.',
    'about.intended': 'Utilisation prévue',
    'about.intendedText':
      'OPTN vous aide à gérer des actifs numériques avec des fonctions avancées de covenant, que vous gériez des fonds personnels ou découvriez les covenants Bitcoin.',
    'about.learn': 'En savoir plus sur les covenants Bitcoin',
    'about.learnText':
      'Explorez ces ressources pour approfondir vos connaissances sur les covenants Bitcoin :',
    'about.wiki': 'Wiki des covenants Bitcoin',
    'about.cashscriptGuide':
      'CashScript — écrire des covenants et introspection',
    'about.cashscriptExamples': 'Exemples de covenants CashScript',
    'about.cointelegraph':
      'Cointelegraph — Que sont les covenants Bitcoin et comment fonctionnent-ils ?',
    'about.feedback': 'Commentaires et assistance',
    'about.feedbackText':
      'Vos commentaires nous aident à améliorer OPTN Wallet. Pour des suggestions, des problèmes ou de l’aide, contactez-nous à',
    'terms.acceptance': '1. Acceptation des conditions',
    'terms.acceptanceText':
      'En accédant à l’application OPTN Wallet (« l’Application ») et en l’utilisant, vous acceptez de respecter les présentes conditions d’utilisation. Si vous n’êtes pas d’accord, n’utilisez pas l’Application.',
    'terms.purpose': '2. Objet',
    'terms.purposeText':
      'L’application OPTN Wallet permet de stocker, envoyer et recevoir des cryptomonnaies en toute sécurité. Vous êtes responsable de la sécurité de vos clés privées et de vos actifs.',
    'terms.responsibilities': '3. Responsabilités de l’utilisateur',
    'terms.responsibilitiesIntro':
      'L’application OPTN Wallet traite de vraies cryptomonnaies. Vous êtes seul responsable de :',
    'terms.safeguard':
      'La protection de vos clés privées et phrases de récupération.',
    'terms.verify':
      'La vérification des détails d’une transaction avant toute confirmation.',
    'terms.deviceSecurity':
      'La sécurité de votre appareil et de l’Application.',
    'terms.responsibilitiesText':
      'L’équipe de développement n’est pas responsable des pertes d’actifs ou des accès non autorisés résultant du non-respect de ces pratiques.',
    'terms.noLiability': '4. Absence de responsabilité',
    'terms.noLiabilityText':
      'Les développeurs déclinent toute responsabilité concernant les pertes, dommages ou accès non autorisés liés à l’utilisation de l’Application, notamment les pertes de cryptomonnaies, les violations de données ou les défaillances de l’appareil. Vous l’utilisez à vos propres risques.',
    'terms.noWarranty': '5. Absence de garantie',
    'terms.noWarrantyText':
      'L’Application est fournie « en l’état », sans garantie expresse ou implicite. Les développeurs ne garantissent ni sa fiabilité, ni son exactitude, ni son exhaustivité, ni un fonctionnement sans erreur ou ininterrompu.',
    'terms.modifications': '6. Modifications',
    'terms.modificationsText':
      'Les développeurs peuvent modifier, suspendre ou arrêter l’Application sans préavis et mettre à jour ces conditions. Vous devez les consulter régulièrement.',
    'paper.title': 'Portefeuille papier',
    'paper.description':
      'Scannez un portefeuille papier WIF et transférez BCH + CashTokens en une transaction.',
    'paper.label': 'Portefeuille papier',
    'paper.notScanned': 'Aucun portefeuille papier scanné.',
    'paper.scan': 'Scanner',
    'paper.sweep': 'Transférer',
    'paper.utxosTitle': 'UTXO du portefeuille papier',
    'paper.spendableOutputSingular': 'sortie dépensable',
    'paper.spendableOutputPlural': 'sorties dépensables',
    'paper.tokenGroups': 'Groupes de tokens',
    'paper.noCashTokens': 'Aucun CashToken détecté.',
    'paper.back': 'Retour',
    'paper.confirmTitle': 'Confirmer le transfert',
    'paper.confirmDescription':
      'Faites glisser pour confirmer le transfert du portefeuille papier en une transaction.',
    'paper.paperInputs': 'Entrées du portefeuille papier',
    'paper.walletFeeInputs': 'Entrées de frais du portefeuille',
    'paper.tokenOutputs': 'Sorties de tokens',
    'paper.bchOutputs': 'Sorties BCH',
    'paper.oneTransaction': 'Une seule transaction.',
    'paper.tokenBacking':
      'Les sorties de tokens sont garanties par 1 000 sats.',
    'paper.noQrCode': 'Aucun QR détecté. Réessayez.',
    'paper.addressDerivationFailed':
      'Impossible de dériver une adresse de portefeuille papier valide depuis la clé scannée.',
    'paper.noUtxos':
      'Aucun UTXO trouvé pour ce portefeuille papier. S’il s’agit d’un portefeuille mainnet sur chipnet, essayez de changer de réseau.',
    'paper.scanBeforeSweep':
      'Scannez un portefeuille papier avant le transfert.',
    'paper.noDestination':
      'Aucune adresse de portefeuille de destination disponible.',
    'paper.buildFailed': 'Échec de création de la transaction de transfert.',
    'paper.sweepBroadcast': 'Transfert diffusé',
    'paper.decodingError': 'Erreur de décodage',
    'paper.addressConversionError': 'Erreur de conversion d’adresse',
    'paper.unexpected': 'Une erreur inattendue s’est produite.',
    'paper.unexpectedTryAgain':
      'Une erreur inattendue s’est produite. Réessayez.',
    'faucet.name': 'Faucet Chipnet',
    'faucet.tooltip': 'Obtenir des BCH Chipnet',
    'faucet.instructions': 'Instructions',
    'faucet.copyAddress': 'Copiez une adresse BCH Chipnet',
    'faucet.clickLink': 'Cliquez sur le lien Faucet Chipnet',
    'faucet.selectNetwork': 'Sélectionnez « chipnet » dans la zone NETWORK',
    'faucet.pasteAddress': 'Collez votre adresse',
    'faucet.captcha': 'Répondez à la question captcha',
    'faucet.getCoins': 'Appuyez sur « Get Coins »',
    'watchOnly.title': 'Aperçu du portefeuille en lecture seule',
    'watchOnly.description':
      'Inspectez des adresses BCH publiques sans importer de clés privées.',
    'watchOnly.type': 'Type de portefeuille en lecture seule',
    'watchOnly.standard': 'Standard',
    'watchOnly.accountXpub': 'xPub du compte',
    'watchOnly.comingNext': 'Bientôt disponible',
    'watchOnly.multisign': 'Multisignature',
    'watchOnly.multipleCosigners': 'Plusieurs cosignataires',
    'watchOnly.network': 'Réseau',
    'watchOnly.mainnet': 'Mainnet',
    'watchOnly.chipnet': 'Chipnet',
    'watchOnly.xpubPlaceholder': 'Collez le xPub exporté par SeedCash',
    'watchOnly.scanCamera': 'Scanner (caméra)',
    'watchOnly.uploadQr': 'Importer un QR',
    'watchOnly.pathNote':
      'Confirmez que SeedCash a exporté ce compte à m/44’/145’/account’. Un xPub BIP32 autonome ne prouve pas son objectif parent ni son chemin de coin.',
    'watchOnly.previewPublic': 'Prévisualiser les adresses publiques',
    'watchOnly.previewTitle': 'Aperçu des adresses publiques',
    'watchOnly.receive': 'Réception #{index}',
    'watchOnly.change': 'Monnaie #{index}',
    'watchOnly.warning':
      'Aperçu public uniquement : cet écran n’enregistre pas encore de portefeuille en lecture seule et ne crée, signe, importe ou diffuse pas de transactions PSBT.',
    'watchOnly.back': 'Retour aux portefeuilles',
    'derivation.invalidActive': 'Le chemin de dérivation actif est invalide.',
    'derivation.required': '{field} est obligatoire.',
    'derivation.invalidValues': 'Valeurs de chemin BIP44 invalides.',
    'derivation.pathPreview': 'Aperçu du chemin',
    'derivation.pathDescription':
      'Chemin de compte BIP44 fixe utilisé par ce portefeuille.',
    'derivation.coinType': 'Type de coin',
    'derivation.bip44CoinType': 'Type de coin BIP44',
    'derivation.networkDefault': 'Valeur réseau par défaut : {value}',
    'derivation.accountIndex': 'Index du compte',
    'derivation.bip44AccountIndex': 'Index du compte BIP44',
    'derivation.usuallyZero': 'Généralement 0',
    'derivation.branchDescription':
      'Les marqueurs hardened sont fixes. Les adresses de réception et de monnaie sont dérivées automatiquement des branches /0/index et /1/index.',
    'derivation.range': 'Saisissez des nombres entiers de 0 à {max}.',
    'derivation.walletNetwork': 'Réseau du portefeuille',
    'derivation.walletNetworkDescription':
      'Choisissez entre les fonds réels sur Mainnet et les fonds de test sur Chipnet.',
    'derivation.addressDerivation': 'Dérivation d’adresse',
    'derivation.addressDerivationDescription':
      'Chemin de compte BIP44 utilisé pour dériver ce portefeuille.',
    'derivation.customize': 'Personnaliser',
    'reconfiguration.preparing': 'Préparation du portefeuille',
    'reconfiguration.preparingDetail':
      'Arrêt de la synchronisation en arrière-plan et reconnexion au réseau choisi.',
    'reconfiguration.clearing':
      'Effacement des anciennes données du portefeuille',
    'reconfiguration.clearingDetail':
      'Suppression des anciennes adresses, de l’historique et des UTXO.',
    'reconfiguration.deriving': 'Génération des adresses du portefeuille',
    'reconfiguration.derivingDetail':
      'Création des adresses de réception et de monnaie pour ce chemin.',
    'reconfiguration.syncing': 'Synchronisation du portefeuille',
    'reconfiguration.syncingDetail':
      'Récupération des soldes, UTXO et de l’historique. Cela peut prendre 15 à 20 secondes.',
    'reconfiguration.switchingNetwork': 'Changement de réseau',
    'reconfiguration.changingPath': 'Modification du chemin de dérivation',
    'reconfiguration.reloading': 'Rechargement du portefeuille',
    'reconfiguration.updating': 'Mise à jour du portefeuille',
    'reconfiguration.movingTo': 'Migration vers {network}',
    'reconfiguration.working': 'Traitement…',
    'reconfiguration.stepOf': 'Étape {current} sur {total}',
    'reconfiguration.progress': 'Progression de la mise à jour du portefeuille',
    'reconfiguration.failed': 'Échec de la mise à jour du portefeuille',
    'reconfiguration.failedDetail':
      'Impossible de reconfigurer le portefeuille.',
    'reconfiguration.dismiss': 'Fermer',
    'reconfiguration.keepOpen':
      'Gardez OPTN Wallet ouvert. La navigation est temporairement désactivée pendant la reconstruction des données.',
  },
  ko: {
    'about.overview': '개요',
    'about.overviewText':
      'OPTN Wallet 앱은 디지털 자산을 직접 관리하고 보호할 수 있게 합니다. Bitcoin 커밋먼트는 자금 사용 규칙을 맞춤 설정합니다.',
    'about.keyFeatures': '주요 기능',
    'about.creating': '지갑 생성 및 가져오기',
    'about.creatingText':
      '다른 Bitcoin 지갑과 호환되는 표준 형식으로 새 지갑을 만들거나 기존 지갑을 가져옵니다.',
    'about.viewing': '커밋먼트 보기',
    'about.viewingText':
      '거래를 관리하는 규칙을 검토하여 자금이 보호되는 방식을 이해합니다.',
    'about.building': '트랜잭션 생성 및 전송',
    'about.buildingText':
      '시간 잠금, 다중 서명 또는 허용 주소와 같은 맞춤 커밋먼트 조건으로 트랜잭션을 구성합니다.',
    'about.security': '보안',
    'about.securityText':
      'Bitcoin 커밋먼트 기능은 무단 트랜잭션으로부터 자산을 보호합니다.',
    'about.why': 'OPTN Wallet을 선택하는 이유',
    'about.unmatched': '탁월한 보안',
    'about.unmatchedText':
      'Bitcoin 커밋먼트로 자금 사용 방식을 정확히 정의합니다.',
    'about.flexibility': '유연성',
    'about.flexibilityText':
      '맞춤 트랜잭션 조건으로 지갑 사용 경험을 조정합니다.',
    'about.intuitive': '직관적인 디자인',
    'about.intuitiveText':
      '초보자도 쉽게 자산을 관리할 수 있는 친화적인 인터페이스입니다.',
    'about.community': '커뮤니티 피드백',
    'about.communityText':
      '베타 테스터의 의견과 실제 사용자 요구를 바탕으로 만들었습니다.',
    'about.intended': '사용 목적',
    'about.intendedText':
      '개인 자금을 관리하거나 Bitcoin 커밋먼트를 탐색할 때 OPTN은 고급 기능으로 디지털 자산 관리를 돕습니다.',
    'about.learn': 'Bitcoin 커밋먼트 더 알아보기',
    'about.learnText':
      'Bitcoin 커밋먼트를 더 깊이 이해하려면 다음 자료를 살펴보세요.',
    'about.wiki': 'Bitcoin 커밋먼트 위키',
    'about.cashscriptGuide': 'CashScript — 커밋먼트 및 introspection 작성',
    'about.cashscriptExamples': 'CashScript 커밋먼트 예제',
    'about.cointelegraph':
      'Cointelegraph — Bitcoin 커밋먼트란 무엇이며 어떻게 작동하나요?',
    'about.feedback': '피드백 및 지원',
    'about.feedbackText':
      '피드백은 OPTN Wallet을 개선하는 데 도움이 됩니다. 제안, 문제 또는 지원 문의는 다음으로 연락하세요:',
    'terms.acceptance': '1. 약관 동의',
    'terms.acceptanceText':
      'OPTN Wallet 앱(“앱”)에 접근하고 사용하면 이 이용 약관을 준수하고 이에 구속되는 데 동의하는 것입니다. 동의하지 않으면 앱을 사용하지 마세요.',
    'terms.purpose': '2. 목적',
    'terms.purposeText':
      'OPTN Wallet 앱은 암호화폐를 안전하게 저장, 전송 및 수신할 수 있게 합니다. 개인 키와 자산의 보안은 사용자의 책임입니다.',
    'terms.responsibilities': '3. 사용자 책임',
    'terms.responsibilitiesIntro':
      'OPTN Wallet 앱은 실제 암호화폐를 처리합니다. 다음 사항은 전적으로 사용자의 책임입니다:',
    'terms.safeguard': '개인 키와 복구 문구 보호',
    'terms.verify': '작업을 확인하기 전에 트랜잭션 세부 정보 확인',
    'terms.deviceSecurity': '기기와 앱의 보안 유지',
    'terms.responsibilitiesText':
      '이러한 절차를 따르지 않아 발생한 자산 손실이나 무단 접근에 대해 개발팀은 책임지지 않습니다.',
    'terms.noLiability': '4. 책임 제한',
    'terms.noLiabilityText':
      '개발자는 앱 사용으로 발생하는 손실, 손해 또는 무단 접근에 대해 책임을 지지 않습니다. 여기에는 암호화폐 손실, 데이터 침해 및 기기 고장이 포함됩니다. 사용자는 자신의 책임으로 앱을 사용합니다.',
    'terms.noWarranty': '5. 보증 없음',
    'terms.noWarrantyText':
      '앱은 명시적 또는 묵시적 보증 없이 “있는 그대로” 제공됩니다. 개발자는 신뢰성, 정확성, 완전성, 오류 없는 작동 또는 중단 없는 서비스를 보장하지 않습니다.',
    'terms.modifications': '6. 변경',
    'terms.modificationsText':
      '개발자는 사전 통지 없이 앱을 변경, 일시 중지 또는 종료할 수 있으며 이 약관을 업데이트할 수 있습니다. 사용자는 정기적으로 확인해야 합니다.',
    'paper.title': '종이 지갑',
    'paper.description':
      'WIF 종이 지갑을 스캔하고 한 번의 트랜잭션으로 BCH + CashTokens를 스윕합니다.',
    'paper.label': '종이 지갑',
    'paper.notScanned': '스캔한 종이 지갑이 없습니다.',
    'paper.scan': '스캔',
    'paper.sweep': '스윕',
    'paper.utxosTitle': '종이 지갑 UTXO',
    'paper.spendableOutputSingular': '사용 가능한 출력',
    'paper.spendableOutputPlural': '사용 가능한 출력',
    'paper.tokenGroups': '토큰 그룹',
    'paper.noCashTokens': 'CashToken을 감지하지 못했습니다.',
    'paper.back': '뒤로',
    'paper.confirmTitle': '스윕 확인',
    'paper.confirmDescription':
      '한 번의 트랜잭션으로 종이 지갑을 스윕하려면 밀어서 확인하세요.',
    'paper.paperInputs': '종이 지갑 입력',
    'paper.walletFeeInputs': '지갑 수수료 입력',
    'paper.tokenOutputs': '토큰 출력',
    'paper.bchOutputs': 'BCH 출력',
    'paper.oneTransaction': '트랜잭션 하나만 사용합니다.',
    'paper.tokenBacking': '토큰 출력은 1000 sats로 뒷받침됩니다.',
    'paper.noQrCode': 'QR 코드를 감지하지 못했습니다. 다시 시도하세요.',
    'paper.addressDerivationFailed':
      '스캔한 키에서 유효한 종이 지갑 주소를 파생하지 못했습니다.',
    'paper.noUtxos':
      '이 종이 지갑의 UTXO를 찾지 못했습니다. mainnet 지갑인데 chipnet에 있다면 네트워크를 전환하세요.',
    'paper.scanBeforeSweep': '스윕하기 전에 종이 지갑을 스캔하세요.',
    'paper.noDestination': '사용 가능한 대상 지갑 주소가 없습니다.',
    'paper.buildFailed': '스윕 트랜잭션을 생성하지 못했습니다.',
    'paper.sweepBroadcast': '스윕 브로드캐스트됨',
    'paper.decodingError': '디코딩 오류',
    'paper.addressConversionError': '주소 변환 오류',
    'paper.unexpected': '예기치 않은 오류가 발생했습니다.',
    'paper.unexpectedTryAgain':
      '예기치 않은 오류가 발생했습니다. 다시 시도하세요.',
    'faucet.name': 'Chipnet Faucet',
    'faucet.tooltip': 'Chipnet BCH 받기',
    'faucet.instructions': '안내',
    'faucet.copyAddress': 'BCH Chipnet 주소 복사',
    'faucet.clickLink': 'Chipnet Faucet 링크 클릭',
    'faucet.selectNetwork': 'NETWORK 상자에서 “chipnet” 선택',
    'faucet.pasteAddress': '주소 붙여넣기',
    'faucet.captcha': 'captcha 질문에 답하기',
    'faucet.getCoins': '“Get Coins” 누르기',
    'watchOnly.title': '보기 전용 지갑 미리보기',
    'watchOnly.description':
      '개인 키를 가져오지 않고 공개 BCH 주소를 확인합니다.',
    'watchOnly.type': '보기 전용 지갑 유형',
    'watchOnly.standard': '표준',
    'watchOnly.accountXpub': '계정 xPub',
    'watchOnly.comingNext': '곧 제공',
    'watchOnly.multisign': '다중 서명',
    'watchOnly.multipleCosigners': '여러 공동 서명자',
    'watchOnly.network': '네트워크',
    'watchOnly.mainnet': 'Mainnet',
    'watchOnly.chipnet': 'Chipnet',
    'watchOnly.xpubPlaceholder': 'SeedCash에서 내보낸 xPub 붙여넣기',
    'watchOnly.scanCamera': '스캔(카메라)',
    'watchOnly.uploadQr': 'QR 업로드',
    'watchOnly.pathNote':
      'SeedCash가 이 계정을 m/44’/145’/account’로 내보냈는지 확인하세요. 독립형 BIP32 xPub만으로는 상위 목적이나 코인 경로를 증명할 수 없습니다.',
    'watchOnly.previewPublic': '공개 주소 미리보기',
    'watchOnly.previewTitle': '공개 주소 미리보기',
    'watchOnly.receive': '수신 #{index}',
    'watchOnly.change': '잔돈 #{index}',
    'watchOnly.warning':
      '공개 미리보기 전용: 이 화면은 아직 보기 전용 지갑을 저장하거나 PSBT 트랜잭션을 생성, 서명, 가져오기 또는 브로드캐스트하지 않습니다.',
    'watchOnly.back': '지갑으로 돌아가기',
    'derivation.invalidActive': '활성 파생 경로가 잘못되었습니다.',
    'derivation.required': '{field}은(는) 필수입니다.',
    'derivation.invalidValues': '잘못된 BIP44 경로 값입니다.',
    'derivation.pathPreview': '경로 미리보기',
    'derivation.pathDescription':
      '이 지갑에서 사용하는 고정 BIP44 계정 경로입니다.',
    'derivation.coinType': '코인 유형',
    'derivation.bip44CoinType': 'BIP44 코인 유형',
    'derivation.networkDefault': '네트워크 기본값: {value}',
    'derivation.accountIndex': '계정 인덱스',
    'derivation.bip44AccountIndex': 'BIP44 계정 인덱스',
    'derivation.usuallyZero': '보통 0',
    'derivation.branchDescription':
      'hardened 표시는 고정됩니다. 수신 및 잔돈 주소는 /0/index와 /1/index 브랜치에서 자동으로 파생됩니다.',
    'derivation.range': '0부터 {max}까지의 정수를 입력하세요.',
    'derivation.walletNetwork': '지갑 네트워크',
    'derivation.walletNetworkDescription':
      'Mainnet의 실제 자금 또는 Chipnet의 테스트 자금에 연결할지 선택합니다.',
    'derivation.addressDerivation': '주소 파생',
    'derivation.addressDerivationDescription':
      '이 지갑을 파생하는 데 사용하는 BIP44 계정 경로입니다.',
    'derivation.customize': '맞춤 설정',
    'reconfiguration.preparing': '지갑 준비 중',
    'reconfiguration.preparingDetail':
      '백그라운드 동기화를 중지하고 선택한 네트워크에 다시 연결합니다.',
    'reconfiguration.clearing': '이전 지갑 데이터 삭제 중',
    'reconfiguration.clearingDetail':
      '이전 주소, 기록 및 UTXO 레코드를 제거합니다.',
    'reconfiguration.deriving': '지갑 주소 생성 중',
    'reconfiguration.derivingDetail':
      '이 지갑 경로의 수신 및 잔돈 주소를 생성합니다.',
    'reconfiguration.syncing': '지갑 동기화 중',
    'reconfiguration.syncingDetail':
      '잔액, UTXO 및 트랜잭션 기록을 가져옵니다. 15~20초가 걸릴 수 있습니다.',
    'reconfiguration.switchingNetwork': '네트워크 전환 중',
    'reconfiguration.changingPath': '파생 경로 변경 중',
    'reconfiguration.reloading': '지갑 다시 로드 중',
    'reconfiguration.updating': '지갑 업데이트 중',
    'reconfiguration.movingTo': '{network}(으)로 이동 중',
    'reconfiguration.working': '처리 중…',
    'reconfiguration.stepOf': '{total}단계 중 {current}단계',
    'reconfiguration.progress': '지갑 업데이트 진행률',
    'reconfiguration.failed': '지갑 업데이트 실패',
    'reconfiguration.failedDetail': '지갑을 다시 구성하지 못했습니다.',
    'reconfiguration.dismiss': '닫기',
    'reconfiguration.keepOpen':
      'OPTN Wallet을 열어 두세요. 지갑 데이터를 다시 구성하는 동안 탐색이 일시적으로 비활성화됩니다.',
  },
  ja: {
    'about.overview': '概要',
    'about.overviewText':
      'OPTN Wallet アプリはデジタル資産を直接管理し、安全に保護できます。Bitcoin covenant で資金の使用ルールを設定し、好みに合わせたウォレットを作れます。',
    'about.keyFeatures': '主な機能',
    'about.creating': 'ウォレットの作成とインポート',
    'about.creatingText':
      '他の Bitcoin ウォレットと互換性のある標準形式で、新しいウォレットを作成または既存のウォレットをインポートします。',
    'about.viewing': 'Covenant の表示',
    'about.viewingText':
      '取引を管理するルールを確認し、資金が保護される仕組みを理解できます。',
    'about.building': 'トランザクションの作成と送信',
    'about.buildingText':
      'タイムロック、マルチシグ要件、許可アドレスなどのカスタム covenant 条件でトランザクションを作成します。',
    'about.security': 'セキュリティ',
    'about.securityText':
      'Bitcoin covenant 機能は不正な取引から資産を保護します。',
    'about.why': 'OPTN Wallet を選ぶ理由',
    'about.unmatched': '優れたセキュリティ',
    'about.unmatchedText':
      'Bitcoin covenant で資金の使用方法を正確に定義できます。',
    'about.flexibility': '柔軟性',
    'about.flexibilityText': 'カスタム取引条件でウォレット体験を調整できます。',
    'about.intuitive': '直感的なデザイン',
    'about.intuitiveText':
      '初心者にも資産管理が分かりやすい使いやすいインターフェースです。',
    'about.community': 'コミュニティからのフィードバック',
    'about.communityText':
      'ベータテスターの意見と実際のユーザーのニーズを取り入れて作られています。',
    'about.intended': '想定用途',
    'about.intendedText':
      '個人資金の管理にも Bitcoin covenant の探索にも、OPTN は高度な機能でデジタル資産の管理を支援します。',
    'about.learn': 'Bitcoin covenant を詳しく知る',
    'about.learnText':
      'Bitcoin covenant の理解を深めるには、次の資料をご覧ください。',
    'about.wiki': 'Bitcoin covenant Wiki',
    'about.cashscriptGuide': 'CashScript — covenant と introspection の作成',
    'about.cashscriptExamples': 'CashScript covenant の例',
    'about.cointelegraph':
      'Cointelegraph — Bitcoin covenant とは何か、どう機能するか',
    'about.feedback': 'フィードバックとサポート',
    'about.feedbackText':
      'フィードバックは OPTN Wallet の改善に役立ちます。提案、問題、サポートについては次の連絡先までお知らせください：',
    'terms.acceptance': '1. 条件への同意',
    'terms.acceptanceText':
      'OPTN Wallet アプリ（「本アプリ」）にアクセスして使用することで、この利用規約に従い拘束されることに同意したものとします。同意しない場合は本アプリを使用しないでください。',
    'terms.purpose': '2. 目的',
    'terms.purposeText':
      'OPTN Wallet アプリでは暗号資産を安全に保管、送信、受信できます。秘密鍵と資産の安全はユーザーの責任です。',
    'terms.responsibilities': '3. ユーザーの責任',
    'terms.responsibilitiesIntro':
      'OPTN Wallet アプリは実際の暗号資産を扱います。次の事項はユーザーが単独で責任を負います：',
    'terms.safeguard': '秘密鍵とリカバリーフレーズの保護。',
    'terms.verify': '操作を確定する前に取引の詳細を確認すること。',
    'terms.deviceSecurity': 'デバイスと本アプリの安全を確保すること。',
    'terms.responsibilitiesText':
      'これらの手順に従わなかったことによる資産の損失や不正アクセスについて、開発チームは責任を負いません。',
    'terms.noLiability': '4. 免責',
    'terms.noLiabilityText':
      '開発者は、本アプリの使用から生じる損失、損害、不正アクセスについて責任を負いません。暗号資産の損失、データ侵害、デバイスの故障も含まれます。使用は自己責任で行ってください。',
    'terms.noWarranty': '5. 保証なし',
    'terms.noWarrantyText':
      '本アプリは明示または黙示の保証なしに「現状のまま」提供されます。開発者は信頼性、正確性、完全性、エラーのない動作、継続的なサービスを保証しません。',
    'terms.modifications': '6. 変更',
    'terms.modificationsText':
      '開発者は事前の通知なく本アプリを変更、一時停止、終了でき、規約を更新することがあります。ユーザーは定期的に確認する責任があります。',
    'paper.title': 'ペーパーウォレット',
    'paper.description':
      'WIF ペーパーウォレットをスキャンし、1 件のトランザクションで BCH + CashTokens をスイープします。',
    'paper.label': 'ペーパーウォレット',
    'paper.notScanned': 'ペーパーウォレットはまだスキャンされていません。',
    'paper.scan': 'スキャン',
    'paper.sweep': 'スイープ',
    'paper.utxosTitle': 'ペーパーウォレットの UTXO',
    'paper.spendableOutputSingular': '使用可能な出力',
    'paper.spendableOutputPlural': '使用可能な出力',
    'paper.tokenGroups': 'トークングループ',
    'paper.noCashTokens': 'CashToken が見つかりません。',
    'paper.back': '戻る',
    'paper.confirmTitle': 'スイープを確認',
    'paper.confirmDescription':
      '1 件のトランザクションでペーパーウォレットをスイープするにはスライドして確認します。',
    'paper.paperInputs': 'ペーパーウォレット入力',
    'paper.walletFeeInputs': 'ウォレット手数料入力',
    'paper.tokenOutputs': 'トークン出力',
    'paper.bchOutputs': 'BCH 出力',
    'paper.oneTransaction': 'トランザクションは 1 件のみです。',
    'paper.tokenBacking': 'トークン出力は 1000 sats で裏付けられます。',
    'paper.noQrCode': 'QR コードを検出できません。もう一度お試しください。',
    'paper.addressDerivationFailed':
      'スキャンしたキーから有効なペーパーウォレットアドレスを導出できませんでした。',
    'paper.noUtxos':
      'このペーパーウォレットの UTXO が見つかりません。mainnet ウォレットで chipnet を使用している場合はネットワークを切り替えてください。',
    'paper.scanBeforeSweep':
      'スイープする前にペーパーウォレットをスキャンしてください。',
    'paper.noDestination': '利用できる送付先ウォレットアドレスがありません。',
    'paper.buildFailed': 'スイープトランザクションを作成できませんでした。',
    'paper.sweepBroadcast': 'スイープをブロードキャストしました',
    'paper.decodingError': 'デコードエラー',
    'paper.addressConversionError': 'アドレス変換エラー',
    'paper.unexpected': '予期しないエラーが発生しました。',
    'paper.unexpectedTryAgain':
      '予期しないエラーが発生しました。もう一度お試しください。',
    'faucet.name': 'Chipnet Faucet',
    'faucet.tooltip': 'Chipnet BCH を取得',
    'faucet.instructions': '手順',
    'faucet.copyAddress': 'BCH Chipnet アドレスをコピー',
    'faucet.clickLink': 'Chipnet Faucet リンクをクリック',
    'faucet.selectNetwork': 'NETWORK ボックスで「chipnet」を選択',
    'faucet.pasteAddress': 'アドレスを貼り付け',
    'faucet.captcha': 'captcha の質問に回答',
    'faucet.getCoins': '「Get Coins」を押す',
    'watchOnly.title': '監視専用ウォレットのプレビュー',
    'watchOnly.description':
      '秘密鍵をインポートせずに公開 BCH アドレスを確認します。',
    'watchOnly.type': '監視専用ウォレットの種類',
    'watchOnly.standard': '標準',
    'watchOnly.accountXpub': 'アカウント xPub',
    'watchOnly.comingNext': '近日公開',
    'watchOnly.multisign': 'マルチシグ',
    'watchOnly.multipleCosigners': '複数の共同署名者',
    'watchOnly.network': 'ネットワーク',
    'watchOnly.mainnet': 'Mainnet',
    'watchOnly.chipnet': 'Chipnet',
    'watchOnly.xpubPlaceholder':
      'SeedCash からエクスポートした xPub を貼り付け',
    'watchOnly.scanCamera': 'スキャン（カメラ）',
    'watchOnly.uploadQr': 'QR をアップロード',
    'watchOnly.pathNote':
      'SeedCash がこのアカウントを m/44’/145’/account’ にエクスポートしたことを確認してください。単独の BIP32 xPub だけでは親の目的や coin パスを証明できません。',
    'watchOnly.previewPublic': '公開アドレスをプレビュー',
    'watchOnly.previewTitle': '公開アドレスのプレビュー',
    'watchOnly.receive': '受取 #{index}',
    'watchOnly.change': 'おつり #{index}',
    'watchOnly.warning':
      '公開プレビューのみ：この画面ではまだ監視専用ウォレットを保存したり、PSBT トランザクションを作成、署名、インポート、ブロードキャストしたりできません。',
    'watchOnly.back': 'ウォレットに戻る',
    'derivation.invalidActive': 'アクティブな導出パスが無効です。',
    'derivation.required': '{field} は必須です。',
    'derivation.invalidValues': '無効な BIP44 パス値です。',
    'derivation.pathPreview': 'パスのプレビュー',
    'derivation.pathDescription':
      'このウォレットで使用する固定 BIP44 アカウントパスです。',
    'derivation.coinType': 'コイン種別',
    'derivation.bip44CoinType': 'BIP44 コイン種別',
    'derivation.networkDefault': 'ネットワークの既定値：{value}',
    'derivation.accountIndex': 'アカウントインデックス',
    'derivation.bip44AccountIndex': 'BIP44 アカウントインデックス',
    'derivation.usuallyZero': '通常は 0',
    'derivation.branchDescription':
      'hardened マーカーは固定です。受取アドレスとおつりアドレスは /0/index と /1/index ブランチから自動的に導出されます。',
    'derivation.range': '0 から {max} までの整数を入力してください。',
    'derivation.walletNetwork': 'ウォレットネットワーク',
    'derivation.walletNetworkDescription':
      'Mainnet の実資金と Chipnet のテスト資金のどちらに接続するか選択します。',
    'derivation.addressDerivation': 'アドレス導出',
    'derivation.addressDerivationDescription':
      'このウォレットの導出に使う BIP44 アカウントパスです。',
    'derivation.customize': 'カスタマイズ',
    'reconfiguration.preparing': 'ウォレットを準備中',
    'reconfiguration.preparingDetail':
      'バックグラウンド同期を停止し、選択したネットワークに再接続しています。',
    'reconfiguration.clearing': '古いウォレットデータを消去中',
    'reconfiguration.clearingDetail':
      '以前のアドレス、履歴、UTXO レコードを削除しています。',
    'reconfiguration.deriving': 'ウォレットアドレスを生成中',
    'reconfiguration.derivingDetail':
      'このウォレットパスの受取アドレスとおつりアドレスを作成しています。',
    'reconfiguration.syncing': 'ウォレットを同期中',
    'reconfiguration.syncingDetail':
      '残高、UTXO、取引履歴を取得しています。15～20 秒かかることがあります。',
    'reconfiguration.switchingNetwork': 'ネットワークを切り替え中',
    'reconfiguration.changingPath': '導出パスを変更中',
    'reconfiguration.reloading': 'ウォレットを再読み込み中',
    'reconfiguration.updating': 'ウォレットを更新中',
    'reconfiguration.movingTo': '{network} に移動中',
    'reconfiguration.working': '処理中…',
    'reconfiguration.stepOf': '{total} 段階中 {current} 段階',
    'reconfiguration.progress': 'ウォレット更新の進行状況',
    'reconfiguration.failed': 'ウォレットの更新に失敗しました',
    'reconfiguration.failedDetail': 'ウォレットを再構成できませんでした。',
    'reconfiguration.dismiss': '閉じる',
    'reconfiguration.keepOpen':
      'OPTN Wallet を開いたままにしてください。ウォレットデータの再構築中はナビゲーションが一時的に無効になります。',
  },
  ru: {
    'about.overview': 'Обзор',
    'about.overviewText':
      'Приложение OPTN Wallet даёт прямой контроль и защиту цифровых активов. Bitcoin covenant позволяют задавать правила расходования средств.',
    'about.keyFeatures': 'Основные возможности',
    'about.creating': 'Создание и импорт кошельков',
    'about.creatingText':
      'Создавайте новые кошельки или импортируйте существующие в стандартных форматах, совместимых с другими Bitcoin-кошельками.',
    'about.viewing': 'Просмотр covenant',
    'about.viewingText':
      'Изучайте правила транзакций, чтобы понимать, как защищены ваши средства.',
    'about.building': 'Создание и отправка транзакций',
    'about.buildingText':
      'Создавайте транзакции с условиями covenant: временными блокировками, мультиподписью или разрешёнными адресами.',
    'about.security': 'Безопасность',
    'about.securityText':
      'Возможности Bitcoin covenant помогают защищать активы от несанкционированных транзакций.',
    'about.why': 'Почему стоит выбрать OPTN Wallet?',
    'about.unmatched': 'Непревзойдённая безопасность',
    'about.unmatchedText':
      'Точно определяйте способы расходования средств с помощью Bitcoin covenant.',
    'about.flexibility': 'Гибкость',
    'about.flexibilityText':
      'Настраивайте кошелёк с помощью собственных условий транзакций.',
    'about.intuitive': 'Интуитивный дизайн',
    'about.intuitiveText':
      'Понятный интерфейс делает управление активами доступным новичкам.',
    'about.community': 'Отзывы сообщества',
    'about.communityText':
      'Создано с учётом отзывов бета-тестеров и реальных потребностей пользователей.',
    'about.intended': 'Назначение',
    'about.intendedText':
      'OPTN помогает управлять цифровыми активами с расширенными covenant — для личных средств и изучения Bitcoin covenant.',
    'about.learn': 'Подробнее о Bitcoin covenant',
    'about.learnText':
      'Изучите эти материалы, чтобы глубже понять Bitcoin covenant:',
    'about.wiki': 'Wiki Bitcoin covenant',
    'about.cashscriptGuide': 'CashScript — написание covenant и introspection',
    'about.cashscriptExamples': 'Примеры covenant CashScript',
    'about.cointelegraph':
      'Cointelegraph — что такое Bitcoin covenant и как они работают?',
    'about.feedback': 'Отзывы и поддержка',
    'about.feedbackText':
      'Ваши отзывы помогают улучшать OPTN Wallet. Для предложений, проблем или поддержки свяжитесь с нами:',
    'terms.acceptance': '1. Принятие условий',
    'terms.acceptanceText':
      'Получая доступ к приложению OPTN Wallet («Приложение») и используя его, вы соглашаетесь соблюдать настоящие условия использования. Если вы не согласны, не используйте Приложение.',
    'terms.purpose': '2. Назначение',
    'terms.purposeText':
      'OPTN Wallet позволяет безопасно хранить, отправлять и получать криптовалюту. Вы отвечаете за безопасность своих закрытых ключей и активов.',
    'terms.responsibilities': '3. Обязанности пользователя',
    'terms.responsibilitiesIntro':
      'OPTN Wallet работает с реальной криптовалютой. Вы полностью отвечаете за:',
    'terms.safeguard': 'Защиту закрытых ключей и фраз восстановления.',
    'terms.verify': 'Проверку данных транзакции перед подтверждением действий.',
    'terms.deviceSecurity': 'Безопасность устройства и Приложения.',
    'terms.responsibilitiesText':
      'Команда разработки не отвечает за потерю активов или несанкционированный доступ из-за несоблюдения этих правил.',
    'terms.noLiability': '4. Отсутствие ответственности',
    'terms.noLiabilityText':
      'Разработчики не отвечают за потери, ущерб или несанкционированный доступ, связанные с использованием Приложения, включая потерю криптовалюты, утечки данных и неисправности устройства. Вы используете его на свой риск.',
    'terms.noWarranty': '5. Отсутствие гарантии',
    'terms.noWarrantyText':
      'Приложение предоставляется «как есть» без явных или подразумеваемых гарантий. Разработчики не гарантируют надёжность, точность, полноту, работу без ошибок или бесперебойность сервиса.',
    'terms.modifications': '6. Изменения',
    'terms.modificationsText':
      'Разработчики могут без предварительного уведомления изменять, приостанавливать или прекращать работу Приложения и обновлять эти условия. Вы должны периодически их проверять.',
    'paper.title': 'Бумажный кошелёк',
    'paper.description':
      'Сканируйте бумажный кошелёк WIF и переведите BCH + CashTokens одной транзакцией.',
    'paper.label': 'Бумажный кошелёк',
    'paper.notScanned': 'Бумажный кошелёк ещё не отсканирован.',
    'paper.scan': 'Сканировать',
    'paper.sweep': 'Перевести',
    'paper.utxosTitle': 'UTXO бумажного кошелька',
    'paper.spendableOutputSingular': 'доступный выход',
    'paper.spendableOutputPlural': 'доступных выхода',
    'paper.tokenGroups': 'Группы токенов',
    'paper.noCashTokens': 'CashToken не обнаружены.',
    'paper.back': 'Назад',
    'paper.confirmTitle': 'Подтвердить перевод',
    'paper.confirmDescription':
      'Сдвиньте, чтобы подтвердить перевод бумажного кошелька одной транзакцией.',
    'paper.paperInputs': 'Входы бумажного кошелька',
    'paper.walletFeeInputs': 'Входы комиссии кошелька',
    'paper.tokenOutputs': 'Выходы токенов',
    'paper.bchOutputs': 'Выходы BCH',
    'paper.oneTransaction': 'Только одна транзакция.',
    'paper.tokenBacking': 'Выходы токенов обеспечены 1000 sats.',
    'paper.noQrCode': 'QR-код не обнаружен. Повторите попытку.',
    'paper.addressDerivationFailed':
      'Не удалось вывести действительный адрес бумажного кошелька из отсканированного ключа.',
    'paper.noUtxos':
      'UTXO для этого бумажного кошелька не найдены. Если кошелёк mainnet открыт в chipnet, попробуйте сменить сеть.',
    'paper.scanBeforeSweep': 'Сначала отсканируйте бумажный кошелёк.',
    'paper.noDestination': 'Адрес кошелька назначения недоступен.',
    'paper.buildFailed': 'Не удалось создать транзакцию перевода.',
    'paper.sweepBroadcast': 'Перевод транслирован',
    'paper.decodingError': 'Ошибка декодирования',
    'paper.addressConversionError': 'Ошибка преобразования адреса',
    'paper.unexpected': 'Произошла неожиданная ошибка.',
    'paper.unexpectedTryAgain':
      'Произошла неожиданная ошибка. Повторите попытку.',
    'faucet.name': 'Faucet Chipnet',
    'faucet.tooltip': 'Получить BCH Chipnet',
    'faucet.instructions': 'Инструкции',
    'faucet.copyAddress': 'Скопируйте адрес BCH Chipnet',
    'faucet.clickLink': 'Нажмите ссылку Faucet Chipnet',
    'faucet.selectNetwork': 'Выберите «chipnet» в поле NETWORK',
    'faucet.pasteAddress': 'Вставьте свой адрес',
    'faucet.captcha': 'Ответьте на вопрос captcha',
    'faucet.getCoins': 'Нажмите «Get Coins»',
    'watchOnly.title': 'Предпросмотр кошелька только для просмотра',
    'watchOnly.description':
      'Просматривайте публичные BCH-адреса без импорта закрытых ключей.',
    'watchOnly.type': 'Тип кошелька только для просмотра',
    'watchOnly.standard': 'Стандартный',
    'watchOnly.accountXpub': 'xPub аккаунта',
    'watchOnly.comingNext': 'Скоро',
    'watchOnly.multisign': 'Мультиподпись',
    'watchOnly.multipleCosigners': 'Несколько соавторов подписи',
    'watchOnly.network': 'Сеть',
    'watchOnly.mainnet': 'Mainnet',
    'watchOnly.chipnet': 'Chipnet',
    'watchOnly.xpubPlaceholder': 'Вставьте xPub, экспортированный SeedCash',
    'watchOnly.scanCamera': 'Сканировать (камера)',
    'watchOnly.uploadQr': 'Загрузить QR',
    'watchOnly.pathNote':
      'Убедитесь, что SeedCash экспортировал этот аккаунт в m/44’/145’/account’. Отдельный BIP32 xPub не подтверждает родительское назначение или путь coin.',
    'watchOnly.previewPublic': 'Предпросмотр публичных адресов',
    'watchOnly.previewTitle': 'Предпросмотр публичных адресов',
    'watchOnly.receive': 'Получение #{index}',
    'watchOnly.change': 'Сдача #{index}',
    'watchOnly.warning':
      'Только публичный просмотр: этот экран пока не сохраняет кошелёк, не создаёт, не подписывает, не импортирует и не транслирует транзакции PSBT.',
    'watchOnly.back': 'Назад к кошелькам',
    'derivation.invalidActive': 'Активный путь деривации недействителен.',
    'derivation.required': '{field} обязателен.',
    'derivation.invalidValues': 'Недействительные значения пути BIP44.',
    'derivation.pathPreview': 'Предпросмотр пути',
    'derivation.pathDescription':
      'Фиксированный путь аккаунта BIP44, используемый этим кошельком.',
    'derivation.coinType': 'Тип coin',
    'derivation.bip44CoinType': 'Тип coin BIP44',
    'derivation.networkDefault': 'Сетевое значение по умолчанию: {value}',
    'derivation.accountIndex': 'Индекс аккаунта',
    'derivation.bip44AccountIndex': 'Индекс аккаунта BIP44',
    'derivation.usuallyZero': 'Обычно 0',
    'derivation.branchDescription':
      'Маркеры hardened фиксированы. Адреса получения и сдачи автоматически выводятся из ветвей /0/index и /1/index.',
    'derivation.range': 'Введите целые числа от 0 до {max}.',
    'derivation.walletNetwork': 'Сеть кошелька',
    'derivation.walletNetworkDescription':
      'Выберите реальные средства в Mainnet или тестовые средства в Chipnet.',
    'derivation.addressDerivation': 'Деривация адреса',
    'derivation.addressDerivationDescription':
      'Путь аккаунта BIP44, используемый для создания этого кошелька.',
    'derivation.customize': 'Настроить',
    'reconfiguration.preparing': 'Подготовка кошелька',
    'reconfiguration.preparingDetail':
      'Остановка фоновой синхронизации и подключение к выбранной сети.',
    'reconfiguration.clearing': 'Очистка старых данных кошелька',
    'reconfiguration.clearingDetail':
      'Удаление прежних адресов, истории и записей UTXO.',
    'reconfiguration.deriving': 'Создание адресов кошелька',
    'reconfiguration.derivingDetail':
      'Создание адресов получения и сдачи для этого пути.',
    'reconfiguration.syncing': 'Синхронизация кошелька',
    'reconfiguration.syncingDetail':
      'Получение балансов, UTXO и истории транзакций. Это может занять 15–20 секунд.',
    'reconfiguration.switchingNetwork': 'Смена сети',
    'reconfiguration.changingPath': 'Изменение пути деривации',
    'reconfiguration.reloading': 'Перезагрузка кошелька',
    'reconfiguration.updating': 'Обновление кошелька',
    'reconfiguration.movingTo': 'Переход в {network}',
    'reconfiguration.working': 'Обработка…',
    'reconfiguration.stepOf': 'Шаг {current} из {total}',
    'reconfiguration.progress': 'Прогресс обновления кошелька',
    'reconfiguration.failed': 'Не удалось обновить кошелёк',
    'reconfiguration.failedDetail': 'Не удалось перенастроить кошелёк.',
    'reconfiguration.dismiss': 'Закрыть',
    'reconfiguration.keepOpen':
      'Не закрывайте OPTN Wallet. Навигация временно отключена, пока данные кошелька перестраиваются.',
  },
  'ha-NG': {
    'about.overview': 'Bayani gaba ɗaya',
    'about.overviewText':
      'Manhajar OPTN Wallet tana ba ka iko kai tsaye da tsaron kadarorin dijital. Bitcoin covenants suna ba ka damar saita ƙa’idodin kashe kuɗi na musamman.',
    'about.keyFeatures': 'Muhimman fasaloli',
    'about.creating': 'Ƙirƙira da shigo da wallets',
    'about.creatingText':
      'Ƙirƙiri sabon wallet ko shigo da wanda kake da shi ta tsarin da sauran Bitcoin wallets ke gane shi.',
    'about.viewing': 'Duba covenants',
    'about.viewingText':
      'Duba ƙa’idodin ciniki domin fahimtar yadda ake kare kuɗinka.',
    'about.building': 'Gina da aika ciniki',
    'about.buildingText':
      'Gina ciniki da sharuɗɗan covenant na musamman kamar time lock, sa hannun mutane da yawa ko adireshi da aka amince da su.',
    'about.security': 'Tsaro',
    'about.securityText':
      'Fasalolin Bitcoin covenant suna taimakawa kare kadarori daga ciniki marar izini.',
    'about.why': 'Me ya sa za ka zaɓi OPTN Wallet?',
    'about.unmatched': 'Tsaro na musamman',
    'about.unmatchedText':
      'Ƙayyade ainihin yadda za a kashe kuɗi ta Bitcoin covenants.',
    'about.flexibility': 'Sauƙin daidaitawa',
    'about.flexibilityText':
      'Daidaita amfani da wallet da sharuɗɗan ciniki na musamman.',
    'about.intuitive': 'Tsari mai sauƙin fahimta',
    'about.intuitiveText':
      'Fuska mai sauƙin amfani da ke taimaka wa sababbin masu amfani sarrafa kadarori.',
    'about.community': 'Ra’ayin al’umma',
    'about.communityText':
      'An gina shi da ra’ayoyin beta testers da ainihin buƙatun masu amfani.',
    'about.intended': 'Amfanin da aka nufa',
    'about.intendedText':
      'OPTN na taimaka maka sarrafa kadarorin dijital da covenant na ci gaba, ko kana kula da kuɗinka ko kana koyon Bitcoin covenants.',
    'about.learn': 'Ƙara koyo game da Bitcoin covenants',
    'about.learnText':
      'Binciki waɗannan albarkatu don ƙara fahimtar Bitcoin covenants:',
    'about.wiki': 'Wiki na Bitcoin covenants',
    'about.cashscriptGuide': 'CashScript — rubuta covenants da introspection',
    'about.cashscriptExamples': 'Misalan CashScript covenant',
    'about.cointelegraph':
      'Cointelegraph — Menene Bitcoin covenants, kuma ta yaya suke aiki?',
    'about.feedback': 'Ra’ayi da taimako',
    'about.feedbackText':
      'Ra’ayinka yana taimaka mana inganta OPTN Wallet. Don shawara, matsala ko taimako, tuntuɓe mu a',
    'terms.acceptance': '1. Karɓar sharuɗɗa',
    'terms.acceptanceText':
      'Ta hanyar shiga da amfani da OPTN Wallet (“Manhajar”), ka yarda ka bi waɗannan Sharuɗɗan Amfani. Idan ba ka yarda ba, kada ka yi amfani da Manhajar.',
    'terms.purpose': '2. Manufa',
    'terms.purposeText':
      'OPTN Wallet tana ba masu amfani damar adana, aika da karɓar cryptocurrency cikin aminci. Kai ne ke da alhakin tsaron maɓallan sirri da kadarorinka.',
    'terms.responsibilities': '3. Alhakin mai amfani',
    'terms.responsibilitiesIntro':
      'OPTN Wallet tana sarrafa cryptocurrency na gaske. Kai kaɗai ne ke da alhakin:',
    'terms.safeguard': 'Kare maɓallan sirri da jimlolin dawo da wallet.',
    'terms.verify': 'Tabbatar da bayanan ciniki kafin tabbatar da wani aiki.',
    'terms.deviceSecurity': 'Tabbatar da tsaron na’urarka da Manhajar.',
    'terms.responsibilitiesText':
      'Ƙungiyar ci gaba ba ta da alhakin asarar kadara ko shiga marar izini saboda rashin bin waɗannan matakai.',
    'terms.noLiability': '4. Babu alhaki',
    'terms.noLiabilityText':
      'Masu haɓakawa ba su da alhakin asara, lahani ko shiga marar izini da ya taso daga amfani da Manhajar, ciki har da asarar cryptocurrency, keta bayanai ko lalacewar na’ura. Kana amfani da ita da kanka cikin haɗari.',
    'terms.noWarranty': '5. Babu garanti',
    'terms.noWarrantyText':
      'Ana bayar da Manhajar “kamar yadda take” ba tare da garanti bayyananne ko na ɓoye ba. Masu haɓakawa ba sa tabbatar da dogaro, daidaito, cikawa, aiki marar kuskure ko sabis marar yankewa.',
    'terms.modifications': '6. Sauye-sauye',
    'terms.modificationsText':
      'Masu haɓakawa na iya gyara, dakatar ko rufe Manhajar ba tare da sanarwa ba, kuma su sabunta waɗannan sharuɗɗa. Kai ne ke da alhakin duba su lokaci-lokaci.',
    'paper.title': 'Wallet na takarda',
    'paper.description':
      'Duba wallet na takarda WIF kuma ka kwashe BCH + CashTokens a ciniki guda.',
    'paper.label': 'Wallet na takarda',
    'paper.notScanned': 'Ba a duba wallet na takarda ba tukuna.',
    'paper.scan': 'Duba',
    'paper.sweep': 'Kwasa',
    'paper.utxosTitle': 'UTXO na wallet na takarda',
    'paper.spendableOutputSingular': 'fitarwa da za a iya kashewa',
    'paper.spendableOutputPlural': 'fitarwa da za a iya kashewa',
    'paper.tokenGroups': 'Rukunin token',
    'paper.noCashTokens': 'Ba a gano CashToken ba.',
    'paper.back': 'Koma',
    'paper.confirmTitle': 'Tabbatar da kwashewa',
    'paper.confirmDescription':
      'Ja don tabbatar da kwashe wallet na takarda a ciniki guda.',
    'paper.paperInputs': 'Shigarwar wallet na takarda',
    'paper.walletFeeInputs': 'Shigarwar kuɗin wallet',
    'paper.tokenOutputs': 'Fitarwar token',
    'paper.bchOutputs': 'Fitarwar BCH',
    'paper.oneTransaction': 'Ciniki guda kawai.',
    'paper.tokenBacking': 'Fitarwar token tana da goyon bayan sats 1000.',
    'paper.noQrCode': 'Ba a gano lambar QR ba. Sake gwadawa.',
    'paper.addressDerivationFailed':
      'An kasa samo ingantaccen adireshin wallet na takarda daga maɓallin da aka duba.',
    'paper.noUtxos':
      'Ba a sami UTXO na wannan wallet na takarda ba. Idan wallet na mainnet ne kana kan chipnet, sauya hanyar sadarwa.',
    'paper.scanBeforeSweep': 'Duba wallet na takarda kafin kwashewa.',
    'paper.noDestination': 'Babu adireshin wallet na inda za a aika.',
    'paper.buildFailed': 'Gina cinikin kwashewa ya gaza.',
    'paper.sweepBroadcast': 'An watsa kwashewa',
    'paper.decodingError': 'Kuskuren fassara bayanai',
    'paper.addressConversionError': 'Kuskuren sauya adireshi',
    'paper.unexpected': 'An sami kuskure da ba a zata ba.',
    'paper.unexpectedTryAgain':
      'An sami kuskure da ba a zata ba. Sake gwadawa.',
    'faucet.name': 'Chipnet Faucet',
    'faucet.tooltip': 'Samo BCH na Chipnet',
    'faucet.instructions': 'Umurni',
    'faucet.copyAddress': 'Kwafi adireshin BCH na Chipnet',
    'faucet.clickLink': 'Danna hanyar Chipnet Faucet',
    'faucet.selectNetwork': 'Zaɓi “chipnet” a akwatin NETWORK',
    'faucet.pasteAddress': 'Manna adireshinka',
    'faucet.captcha': 'Amsa tambayar captcha',
    'faucet.getCoins': 'Danna “Get Coins”',
    'watchOnly.title': 'Samfotin wallet na kallo kawai',
    'watchOnly.description':
      'Duba adireshin BCH na jama’a ba tare da shigo da maɓallan sirri ba.',
    'watchOnly.type': 'Nau’in wallet na kallo kawai',
    'watchOnly.standard': 'Na yau da kullum',
    'watchOnly.accountXpub': 'xPub na account',
    'watchOnly.comingNext': 'Zai zo nan gaba',
    'watchOnly.multisign': 'Sa hannu da yawa',
    'watchOnly.multipleCosigners': 'Masu sa hannu da yawa',
    'watchOnly.network': 'Hanyar sadarwa',
    'watchOnly.mainnet': 'Mainnet',
    'watchOnly.chipnet': 'Chipnet',
    'watchOnly.xpubPlaceholder': 'Manna xPub da SeedCash ya fitar',
    'watchOnly.scanCamera': 'Duba (kamara)',
    'watchOnly.uploadQr': 'Loda QR',
    'watchOnly.pathNote':
      'Tabbatar SeedCash ya fitar da wannan account a m/44’/145’/account’. xPub na BIP32 shi kaɗai ba zai tabbatar da manufar mahaifi ko hanyar coin ba.',
    'watchOnly.previewPublic': 'Samfotin adireshin jama’a',
    'watchOnly.previewTitle': 'Samfotin adireshin jama’a',
    'watchOnly.receive': 'Karɓa #{index}',
    'watchOnly.change': 'Canji #{index}',
    'watchOnly.warning':
      'Samfotin jama’a kawai: wannan allo bai adana wallet na kallo kawai ko ƙirƙira, sa hannu, shigo da ko watsa cinikin PSBT ba tukuna.',
    'watchOnly.back': 'Koma wallets',
    'derivation.invalidActive': 'Hanyar derivation mai aiki ba daidai ba ce.',
    'derivation.required': 'Ana buƙatar {field}.',
    'derivation.invalidValues': 'Ƙimomin hanyar BIP44 ba daidai ba ne.',
    'derivation.pathPreview': 'Samfotin hanya',
    'derivation.pathDescription':
      'Kafaffen hanyar account na BIP44 da wannan wallet ke amfani da ita.',
    'derivation.coinType': 'Nau’in coin',
    'derivation.bip44CoinType': 'Nau’in coin na BIP44',
    'derivation.networkDefault': 'Tsohon ƙimar hanyar sadarwa: {value}',
    'derivation.accountIndex': 'Fihirisar account',
    'derivation.bip44AccountIndex': 'Fihirisar account na BIP44',
    'derivation.usuallyZero': 'Yawanci 0',
    'derivation.branchDescription':
      'Alamomin hardened a kulle suke. Ana samo adireshin karɓa da canji kai tsaye daga rassan /0/index da /1/index.',
    'derivation.range': 'Shigar da cikakkun lambobi daga 0 zuwa {max}.',
    'derivation.walletNetwork': 'Hanyar sadarwar wallet',
    'derivation.walletNetworkDescription':
      'Zaɓi kuɗin gaske a Mainnet ko kuɗin gwaji a Chipnet.',
    'derivation.addressDerivation': 'Samo adireshi',
    'derivation.addressDerivationDescription':
      'Hanyar account na BIP44 da ake amfani da ita wajen samo wannan wallet.',
    'derivation.customize': 'Keɓance',
    'reconfiguration.preparing': 'Ana shirya wallet',
    'reconfiguration.preparingDetail':
      'Ana dakatar da daidaitawar baya kuma ana sake haɗawa da hanyar sadarwar da aka zaɓa.',
    'reconfiguration.clearing': 'Ana share tsoffin bayanan wallet',
    'reconfiguration.clearingDetail':
      'Ana cire tsoffin adireshi, tarihi da bayanan UTXO.',
    'reconfiguration.deriving': 'Ana ƙirƙirar adireshin wallet',
    'reconfiguration.derivingDetail':
      'Ana ƙirƙirar adireshin karɓa da canji don wannan hanyar wallet.',
    'reconfiguration.syncing': 'Ana daidaita wallet',
    'reconfiguration.syncingDetail':
      'Ana samo ragowar kuɗi, UTXO da tarihin ciniki. Wannan na iya ɗaukar sakan 15–20.',
    'reconfiguration.switchingNetwork': 'Ana sauya hanyar sadarwa',
    'reconfiguration.changingPath': 'Ana canja hanyar derivation',
    'reconfiguration.reloading': 'Ana sake loda wallet',
    'reconfiguration.updating': 'Ana sabunta wallet',
    'reconfiguration.movingTo': 'Ana matsawa zuwa {network}',
    'reconfiguration.working': 'Ana aiki…',
    'reconfiguration.stepOf': 'Mataki {current} cikin {total}',
    'reconfiguration.progress': 'Ci gaban sabunta wallet',
    'reconfiguration.failed': 'Sabunta wallet ya gaza',
    'reconfiguration.failedDetail': 'An kasa sake tsara wallet.',
    'reconfiguration.dismiss': 'Rufe',
    'reconfiguration.keepOpen':
      'Ka bar OPTN Wallet a buɗe. An kashe zirga-zirga na ɗan lokaci yayin sake gina bayanan wallet.',
  },
};

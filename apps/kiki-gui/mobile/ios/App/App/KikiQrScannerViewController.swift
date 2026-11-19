import AVFoundation
import CoreImage
import PhotosUI
import UIKit
import Vision

enum KikiQrScanResult {
    case scanned(String)
    case cancelled
    case denied
}

final class KikiQrScannerViewController: UIViewController, AVCaptureMetadataOutputObjectsDelegate, PHPickerViewControllerDelegate {
    private let onComplete: (KikiQrScanResult) -> Void
    private var hasCompleted = false
    private var cameraPermissionDenied = false

    private let sessionQueue = DispatchQueue(label: "ai.easyagent.kiki.qr.session")
    private var captureSession: AVCaptureSession?
    private var previewLayer: AVCaptureVideoPreviewLayer?
    private var cameraRunning = false

    private let isChinese: Bool = {
        Locale.preferredLanguages.first?.lowercased().hasPrefix("zh") == true
    }()

    private lazy var paperColor = UIColor { traits in
        traits.userInterfaceStyle == .dark
            ? UIColor(red: 0.106, green: 0.133, blue: 0.149, alpha: 1)
            : UIColor(red: 0.984, green: 0.980, blue: 0.965, alpha: 1)
    }

    private lazy var inkColor = UIColor { traits in
        traits.userInterfaceStyle == .dark
            ? UIColor(red: 0.933, green: 0.918, blue: 0.886, alpha: 1)
            : UIColor(red: 0.106, green: 0.102, blue: 0.090, alpha: 1)
    }

    private lazy var inkFaintColor = UIColor { traits in
        traits.userInterfaceStyle == .dark
            ? UIColor(red: 0.643, green: 0.616, blue: 0.573, alpha: 1)
            : UIColor(red: 0.400, green: 0.369, blue: 0.329, alpha: 1)
    }

    private lazy var accentColor = UIColor { traits in
        traits.userInterfaceStyle == .dark
            ? UIColor(red: 0.922, green: 0.580, blue: 0.435, alpha: 1)
            : UIColor(red: 0.784, green: 0.251, blue: 0.102, alpha: 1)
    }

    private lazy var onAccentColor = UIColor { traits in
        traits.userInterfaceStyle == .dark
            ? UIColor(red: 0.149, green: 0.102, blue: 0.078, alpha: 1)
            : UIColor(red: 1.0, green: 0.980, blue: 0.961, alpha: 1)
    }

    private let previewContainer = UIView()
    private let overlayMaskLayer = CAShapeLayer()
    private let reticleView = UIView()
    private let statusLabel = UILabel()
    private let fallbackContainer = UIStackView()
    private let fallbackTitleLabel = UILabel()
    private let fallbackBodyLabel = UILabel()
    private let fallbackPhotoButton = UIButton(type: .system)
    private let topBar = UIView()
    private let cancelButton = UIButton(type: .system)
    private let titleLabel = UILabel()
    private let photoButton = UIButton(type: .system)

    init(onComplete: @escaping (KikiQrScanResult) -> Void) {
        self.onComplete = onComplete
        super.init(nibName: nil, bundle: nil)
        modalPresentationStyle = .fullScreen
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    override var preferredStatusBarStyle: UIStatusBarStyle {
        cameraRunning ? .lightContent : .default
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = paperColor
        setupLayout()
        configureCameraOrFallback()
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        previewLayer?.frame = previewContainer.bounds
        updateReticleMask()
    }

    override func viewWillDisappear(_ animated: Bool) {
        super.viewWillDisappear(animated)
        stopCaptureSession()
    }

    private func setupLayout() {
        previewContainer.translatesAutoresizingMaskIntoConstraints = false
        previewContainer.backgroundColor = UIColor(red: 0.07, green: 0.08, blue: 0.09, alpha: 1)
        previewContainer.isHidden = true
        view.addSubview(previewContainer)

        overlayMaskLayer.fillRule = .evenOdd
        overlayMaskLayer.fillColor = UIColor.black.withAlphaComponent(0.56).cgColor
        previewContainer.layer.addSublayer(overlayMaskLayer)

        reticleView.translatesAutoresizingMaskIntoConstraints = false
        reticleView.backgroundColor = .clear
        reticleView.layer.cornerRadius = 18
        reticleView.layer.borderWidth = 2
        reticleView.layer.borderColor = UIColor(red: 1.0, green: 0.98, blue: 0.96, alpha: 0.85).cgColor
        reticleView.isUserInteractionEnabled = false
        previewContainer.addSubview(reticleView)

        statusLabel.translatesAutoresizingMaskIntoConstraints = false
        statusLabel.text = isChinese ? "对准电脑上的二维码" : "Point at the QR code on your computer"
        statusLabel.textColor = UIColor(red: 1.0, green: 0.98, blue: 0.96, alpha: 0.92)
        statusLabel.font = .systemFont(ofSize: 15, weight: .medium)
        statusLabel.textAlignment = .center
        statusLabel.numberOfLines = 2
        previewContainer.addSubview(statusLabel)

        fallbackContainer.translatesAutoresizingMaskIntoConstraints = false
        fallbackContainer.axis = .vertical
        fallbackContainer.alignment = .center
        fallbackContainer.spacing = 14
        fallbackContainer.isHidden = true
        view.addSubview(fallbackContainer)

        fallbackTitleLabel.font = .systemFont(ofSize: 22, weight: .semibold)
        fallbackTitleLabel.textColor = inkColor
        fallbackTitleLabel.textAlignment = .center
        fallbackTitleLabel.numberOfLines = 0

        fallbackBodyLabel.font = .systemFont(ofSize: 15, weight: .regular)
        fallbackBodyLabel.textColor = inkFaintColor
        fallbackBodyLabel.textAlignment = .center
        fallbackBodyLabel.numberOfLines = 0

        let photoTitle = isChinese ? "从相册选择二维码" : "Choose QR photo"
        if #available(iOS 15.0, *) {
            var config = UIButton.Configuration.filled()
            config.title = photoTitle
            config.baseBackgroundColor = accentColor
            config.baseForegroundColor = onAccentColor
            config.cornerStyle = .fixed
            config.background.cornerRadius = 12
            config.contentInsets = NSDirectionalEdgeInsets(top: 14, leading: 24, bottom: 14, trailing: 24)
            config.titleTextAttributesTransformer = UIConfigurationTextAttributesTransformer { incoming in
                var outgoing = incoming
                outgoing.font = .systemFont(ofSize: 16, weight: .semibold)
                return outgoing
            }
            fallbackPhotoButton.configuration = config
        } else {
            fallbackPhotoButton.setTitle(photoTitle, for: .normal)
            fallbackPhotoButton.setTitleColor(onAccentColor, for: .normal)
            fallbackPhotoButton.titleLabel?.font = .systemFont(ofSize: 16, weight: .semibold)
            fallbackPhotoButton.backgroundColor = accentColor
            fallbackPhotoButton.layer.cornerRadius = 12
            fallbackPhotoButton.contentEdgeInsets = UIEdgeInsets(top: 14, left: 24, bottom: 14, right: 24)
        }
        fallbackPhotoButton.addTarget(self, action: #selector(pickPhotoTapped), for: .touchUpInside)

        fallbackContainer.addArrangedSubview(fallbackTitleLabel)
        fallbackContainer.addArrangedSubview(fallbackBodyLabel)
        fallbackContainer.setCustomSpacing(24, after: fallbackBodyLabel)
        fallbackContainer.addArrangedSubview(fallbackPhotoButton)

        topBar.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(topBar)

        cancelButton.translatesAutoresizingMaskIntoConstraints = false
        cancelButton.setTitle(isChinese ? "取消" : "Cancel", for: .normal)
        cancelButton.titleLabel?.font = .systemFont(ofSize: 16, weight: .medium)
        cancelButton.addTarget(self, action: #selector(cancelTapped), for: .touchUpInside)
        topBar.addSubview(cancelButton)

        titleLabel.translatesAutoresizingMaskIntoConstraints = false
        titleLabel.text = isChinese ? "扫码连接" : "Scan QR code"
        titleLabel.font = .systemFont(ofSize: 17, weight: .semibold)
        titleLabel.textAlignment = .center
        topBar.addSubview(titleLabel)

        photoButton.translatesAutoresizingMaskIntoConstraints = false
        photoButton.setTitle(isChinese ? "从相册选择" : "Choose Photo", for: .normal)
        photoButton.titleLabel?.font = .systemFont(ofSize: 15, weight: .medium)
        photoButton.addTarget(self, action: #selector(pickPhotoTapped), for: .touchUpInside)
        topBar.addSubview(photoButton)

        NSLayoutConstraint.activate([
            previewContainer.topAnchor.constraint(equalTo: view.topAnchor),
            previewContainer.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            previewContainer.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            previewContainer.bottomAnchor.constraint(equalTo: view.bottomAnchor),

            reticleView.centerXAnchor.constraint(equalTo: previewContainer.centerXAnchor),
            reticleView.centerYAnchor.constraint(equalTo: previewContainer.centerYAnchor, constant: -16),
            reticleView.widthAnchor.constraint(equalToConstant: 256),
            reticleView.heightAnchor.constraint(equalToConstant: 256),

            statusLabel.topAnchor.constraint(equalTo: reticleView.bottomAnchor, constant: 24),
            statusLabel.leadingAnchor.constraint(equalTo: previewContainer.leadingAnchor, constant: 28),
            statusLabel.trailingAnchor.constraint(equalTo: previewContainer.trailingAnchor, constant: -28),

            fallbackContainer.centerYAnchor.constraint(equalTo: view.centerYAnchor),
            fallbackContainer.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 32),
            fallbackContainer.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -32),
            fallbackPhotoButton.widthAnchor.constraint(greaterThanOrEqualToConstant: 220),

            topBar.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor),
            topBar.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            topBar.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            topBar.heightAnchor.constraint(equalToConstant: 52),

            cancelButton.leadingAnchor.constraint(equalTo: topBar.leadingAnchor, constant: 16),
            cancelButton.centerYAnchor.constraint(equalTo: topBar.centerYAnchor),

            titleLabel.centerXAnchor.constraint(equalTo: topBar.centerXAnchor),
            titleLabel.centerYAnchor.constraint(equalTo: topBar.centerYAnchor),

            photoButton.trailingAnchor.constraint(equalTo: topBar.trailingAnchor, constant: -16),
            photoButton.centerYAnchor.constraint(equalTo: topBar.centerYAnchor),
        ])

        applyBarChrome(overCamera: false)
    }

    private func applyBarChrome(overCamera: Bool) {
        if overCamera {
            let white = UIColor(red: 1.0, green: 0.98, blue: 0.96, alpha: 1)
            cancelButton.setTitleColor(white, for: .normal)
            titleLabel.textColor = white
            photoButton.setTitleColor(white, for: .normal)
        } else {
            cancelButton.setTitleColor(inkColor, for: .normal)
            titleLabel.textColor = inkColor
            photoButton.setTitleColor(accentColor, for: .normal)
        }
        setNeedsStatusBarAppearanceUpdate()
    }

    private func updateReticleMask() {
        let bounds = previewContainer.bounds
        guard bounds.width > 0, bounds.height > 0 else { return }
        let path = UIBezierPath(rect: bounds)
        let cutout = UIBezierPath(roundedRect: reticleView.frame, cornerRadius: 18)
        path.append(cutout)
        overlayMaskLayer.frame = bounds
        overlayMaskLayer.path = path.cgPath
    }

    private func configureCameraOrFallback() {
        guard AVCaptureDevice.default(for: .video) != nil else {
            showFallback(
                title: isChinese ? "当前设备无法启用相机" : "Camera unavailable",
                body: isChinese ? "可从相册选择电脑上的配对二维码截图，或返回手动输入。" : "Choose a saved QR screenshot from Photos, or return to enter manually."
            )
            return
        }

        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .authorized:
            startCameraSession()
        case .notDetermined:
            AVCaptureDevice.requestAccess(for: .video) { [weak self] granted in
                DispatchQueue.main.async {
                    guard let self else { return }
                    if granted {
                        self.startCameraSession()
                    } else {
                        self.cameraPermissionDenied = true
                        self.showFallback(
                            title: self.isChinese ? "未开启相机权限" : "Camera access is off",
                            body: self.isChinese ? "仍可从相册选择配对二维码截图，或返回手动输入。" : "You can still choose a QR screenshot from Photos, or return to enter manually."
                        )
                    }
                }
            }
        default:
            cameraPermissionDenied = true
            showFallback(
                title: isChinese ? "未开启相机权限" : "Camera access is off",
                body: isChinese ? "仍可从相册选择配对二维码截图，或返回手动输入。" : "You can still choose a QR screenshot from Photos, or return to enter manually."
            )
        }
    }

    private func showFallback(title: String, body: String) {
        cameraRunning = false
        previewContainer.isHidden = true
        fallbackContainer.isHidden = false
        fallbackTitleLabel.text = title
        fallbackBodyLabel.text = body
        applyBarChrome(overCamera: false)
    }

    private func startCameraSession() {
        sessionQueue.async { [weak self] in
            guard let self else { return }
            let session = AVCaptureSession()
            session.beginConfiguration()
            guard let device = AVCaptureDevice.default(for: .video),
                  let input = try? AVCaptureDeviceInput(device: device),
                  session.canAddInput(input) else {
                session.commitConfiguration()
                DispatchQueue.main.async {
                    self.showFallback(
                        title: self.isChinese ? "无法启动相机" : "Camera unavailable",
                        body: self.isChinese ? "可从相册选择配对二维码截图，或返回手动输入。" : "Choose a saved QR screenshot from Photos, or return to enter manually."
                    )
                }
                return
            }
            session.addInput(input)

            let output = AVCaptureMetadataOutput()
            guard session.canAddOutput(output) else {
                session.commitConfiguration()
                return
            }
            session.addOutput(output)
            output.setMetadataObjectsDelegate(self, queue: DispatchQueue.main)
            if output.availableMetadataObjectTypes.contains(.qr) {
                output.metadataObjectTypes = [.qr]
            }
            session.commitConfiguration()
            self.captureSession = session

            DispatchQueue.main.async {
                let preview = AVCaptureVideoPreviewLayer(session: session)
                preview.videoGravity = .resizeAspectFill
                preview.frame = self.previewContainer.bounds
                self.previewContainer.layer.insertSublayer(preview, at: 0)
                self.previewLayer = preview
                self.fallbackContainer.isHidden = true
                self.previewContainer.isHidden = false
                self.cameraRunning = true
                self.applyBarChrome(overCamera: true)
                self.updateReticleMask()
            }

            session.startRunning()
        }
    }

    private func stopCaptureSession() {
        let session = captureSession
        captureSession = nil
        sessionQueue.async {
            if session?.isRunning == true {
                session?.stopRunning()
            }
        }
    }

    func metadataOutput(
        _ output: AVCaptureMetadataOutput,
        didOutput metadataObjects: [AVMetadataObject],
        from connection: AVCaptureConnection
    ) {
        guard !hasCompleted else { return }
        for object in metadataObjects {
            if let readable = object as? AVMetadataMachineReadableCodeObject,
               readable.type == .qr,
               let payload = readable.stringValue,
               !payload.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                UINotificationFeedbackGenerator().notificationOccurred(.success)
                finish(with: .scanned(payload))
                return
            }
        }
    }

    @objc private func cancelTapped() {
        finish(with: cameraPermissionDenied ? .denied : .cancelled)
    }

    @objc private func pickPhotoTapped() {
        var config = PHPickerConfiguration(photoLibrary: .shared())
        config.filter = .images
        config.selectionLimit = 1
        let picker = PHPickerViewController(configuration: config)
        picker.delegate = self
        present(picker, animated: true)
    }

    func picker(_ picker: PHPickerViewController, didFinishPicking results: [PHPickerResult]) {
        picker.dismiss(animated: true)
        guard let provider = results.first?.itemProvider,
              provider.canLoadObject(ofClass: UIImage.self) else {
            return
        }
        provider.loadObject(ofClass: UIImage.self) { [weak self] object, _ in
            guard let self, let image = object as? UIImage else { return }
            self.detectQrInImage(image)
        }
    }

    private func detectQrInImage(_ image: UIImage) {
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            guard let self else { return }
            let cgImage: CGImage?
            if let direct = image.cgImage {
                cgImage = direct
            } else if let ci = image.ciImage {
                cgImage = CIContext().createCGImage(ci, from: ci.extent)
            } else {
                cgImage = nil
            }
            guard let cgImage else {
                DispatchQueue.main.async { self.showNoQrInPhotoFeedback() }
                return
            }
            let request = VNDetectBarcodesRequest()
            request.symbologies = [.qr]
            let handler = VNImageRequestHandler(cgImage: cgImage, options: [:])
            var detectedPayload: String?
            do {
                try handler.perform([request])
                detectedPayload = request.results?
                    .compactMap { $0.payloadStringValue?.trimmingCharacters(in: .whitespacesAndNewlines) }
                    .first { !$0.isEmpty }
            } catch {
                detectedPayload = nil
            }
            if detectedPayload == nil {
                let ciImage = CIImage(cgImage: cgImage)
                let detector = CIDetector(
                    ofType: CIDetectorTypeQRCode,
                    context: nil,
                    options: [CIDetectorAccuracy: CIDetectorAccuracyHigh]
                )
                let features = detector?.features(in: ciImage) as? [CIQRCodeFeature] ?? []
                detectedPayload = features
                    .compactMap { $0.messageString?.trimmingCharacters(in: .whitespacesAndNewlines) }
                    .first { !$0.isEmpty }
            }
            DispatchQueue.main.async {
                if let payload = detectedPayload {
                    UINotificationFeedbackGenerator().notificationOccurred(.success)
                    self.finish(with: .scanned(payload))
                } else {
                    self.showNoQrInPhotoFeedback()
                }
            }
        }
    }

    private func showNoQrInPhotoFeedback() {
        let message = isChinese ? "未在这张图片中识别到二维码" : "No QR code found in this photo"
        if cameraRunning {
            statusLabel.text = message
        } else {
            fallbackBodyLabel.text = message
        }
    }

    private func finish(with result: KikiQrScanResult) {
        guard !hasCompleted else { return }
        hasCompleted = true
        stopCaptureSession()
        dismiss(animated: true) { [onComplete] in
            onComplete(result)
        }
    }
}

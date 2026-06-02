# Technical Specification - Version 4

## 1 Scope

This document defines the technical requirements for the communication protocol between network elements in 5G standalone and non-standalone networks.

## 2 References

The following documents contain provisions which, through reference in this text, constitute provisions of the present document.

- [1] 3GPP TS 38.300: "NR; Overall description; Stage 2"
- [2] 3GPP TS 38.413: "NG-RAN; NG Application Protocol (NGAP)"
- [3] 3GPP TS 38.331: "NR; Radio Resource Control (RRC) protocol specification"
- [4] 3GPP TS 33.501: "Security architecture and procedures for 5G System"
- [5] 3GPP TS 38.214: "NR; Physical layer procedures for data"

## 3 Definitions and Abbreviations

### 3.1 Definitions

For the purposes of the present document, the following terms and definitions apply:

**Base Station**: A network element that provides radio coverage.

**User Equipment**: A mobile device that connects to the network.

**Cell**: The geographical area covered by a base station.

**Bearer**: A transmission path with defined QoS characteristics.

**Beam**: A directional transmission pattern used in mmWave communications.

### 3.2 Abbreviations

For the purposes of the present document, the following abbreviations apply:

- AMF Access and Mobility Management Function
- gNB Next Generation Node B
- UE User Equipment
- QoS Quality of Service
- RRC Radio Resource Control
- SDAP Service Data Adaptation Protocol
- NSA Non-Standalone
- SA Standalone

## 4 General Architecture

### 4.1 Overview

The system architecture consists of three main components:

- Core Network (CN) including AMF, SMF, UPF, and AUSF
- Radio Access Network (RAN)
- User Equipment (UE)

The communication between these components is based on standardized interfaces defined by 3GPP Release 15 and later.

### 4.2 Protocol Stack

The protocol stack includes the following layers:

- Physical Layer (PHY)
- Medium Access Control (MAC)
- Radio Link Control (RLC)
- Packet Data Convergence Protocol (PDCP)
- Service Data Adaptation Protocol (SDAP)

**NOTE 2**: SDAP is only used in 5G networks.

**NOTE 3**: The PDCP layer handles ciphering, integrity protection, and header compression.

### 4.3 Deployment Scenarios

The following deployment scenarios are supported:

- Standalone (SA): 5G Core with 5G RAN
- Non-Standalone (NSA) Option 3: LTE Core with LTE and NR RAN
- Non-Standalone (NSA) Option 4: 5G Core with LTE and NR RAN

## 5 Mathematical Models

### 5.1 Signal-to-Noise Ratio

The signal-to-noise ratio is calculated as:

$$ SNR = 10 \log_{10} \left( \frac{P_{signal}}{P_{noise}} \right) $$

where $P_{signal}$ is the signal power and $P_{noise}$ is the noise power in the same bandwidth.

### 5.2 Path Loss

The path loss in dB is calculated using the following formula:

$$ PL = 128.1 + 37.6 \log_{10}(d) $$

where $d$ is the distance in kilometers.

**NOTE 4**: This formula applies to urban macro scenarios at 2 GHz.

For mmWave frequencies (24-100 GHz):

$$ PL = 32.4 + 20 \log_{10}(f) + 30 \log_{10}(d) $$

where $f$ is the frequency in GHz.

## 6 Interface Parameters

### 6.1 Timing Parameters

Table 6.1-1: Timing parameters

| Parameter | Value | Unit | Description |
|-----------|-------|------|-------------|
| T300 | 1000 | ms | RRC connection setup timeout |
| T301 | 2000 | ms | RRC connection re-establishment timeout |
| T310 | 3000 | ms | Radio link failure timer |
| T311 | 10000 | ms | RRC connection re-establishment procedure timer |
| T319 | 5000 | ms | RRC suspend timer |
| T320 | 60000 | ms | Periodic registration update timer |
| T321 | 30000 | ms | Reconfiguration with sync timer |

### 6.2 Power Parameters

The transmit power shall be within the following ranges:

- Minimum power: -40 dBm
- Maximum power: 23 dBm (for power class 3)
- Power control step: 1 dB
- Power control range: 63 dB

**NOTE 5**: Different power classes may have different maximum power values.

Table 6.2-1: Power classes

| Power Class | Maximum Power | Typical Device |
|-------------|---------------|----------------|
| 1 | 33 dBm | Fixed wireless access |
| 2 | 26 dBm | Mobile routers |
| 3 | 23 dBm | Smartphones |
| 4 | 20 dBm | IoT devices |

## 7 Procedures

### 7.1 Connection Establishment

The connection establishment procedure consists of the following steps:

- UE sends RRC Connection Request with establishment cause
- gNB validates the request and allocates resources
- gNB responds with RRC Connection Setup
- UE sends RRC Connection Setup Complete with capability information
- Connection is established
- Initial security activation is performed

**NOTE 1**: The UE shall include its capabilities in the RRC Connection Setup Complete message.

### 7.2 Handover Procedure

The handover procedure is initiated when the signal quality falls below a threshold or load balancing is required.

**EXAMPLE**: If the RSRP is below -110 dBm for more than 5 seconds, the UE triggers a measurement report.

The handover can be either intra-frequency or inter-frequency depending on the target cell.

Steps:

- Source gNB sends Handover Request to target gNB
- Target gNB prepares resources and responds with Handover Request Acknowledge
- Source gNB sends RRC Reconfiguration to UE
- UE performs handover and confirms to target gNB
- Target gNB sends Path Switch Request to AMF
- AMF updates the path

### 7.3 Connection Release

The connection release procedure is initiated by the network when the UE is idle for an extended period.

- gNB sends RRC Connection Release with optional redirect information
- UE acknowledges and returns to idle mode
- Context is cleared on both sides
- NAS signaling is updated if needed

## 8 Security

### 8.1 Authentication

The authentication procedure uses a challenge-response mechanism based on shared keys and 5G-AKA protocol.

The authentication vector includes:

- RAND (random challenge)
- AUTN (authentication token)
- XRES (expected response)
- KAUSF (key for AUSF)
- KSEAF (key for SEAF)

### 8.2 Encryption

All user plane data shall be encrypted using the specified algorithms:

- NEA0 (null encryption - for testing only)
- NEA1 (SNOW 3G)
- NEA2 (AES)
- NEA3 (ZUC)

**NOTE 7**: The network selects the encryption algorithm based on UE capabilities and operator policy.

### 8.3 Integrity Protection

Control plane messages are protected using integrity algorithms:

- NIA1 (SNOW 3G)
- NIA2 (AES)
- NIA3 (ZUC)

**NOTE 6**: User plane integrity protection is optional and configured per bearer.

## 9 Quality of Service

### 9.1 QoS Framework

The 5G QoS framework introduces the concept of QoS flows:

- Each PDU session contains one or more QoS flows
- QoS flows are identified by QoS Flow Identifier (QFI)
- Each QoS flow has a specific 5QI (5G QoS Identifier)

### 9.2 Standard 5QI Values

Table 9.2-1: Standardized 5QI characteristics

| 5QI | Resource Type | Priority | Packet Delay Budget | Packet Error Rate | Example Service |
|-----|---------------|----------|---------------------|-------------------|-----------------|
| 1 | GBR | 20 | 100 ms | 10^-2 | Conversational Voice |
| 2 | GBR | 40 | 150 ms | 10^-3 | Conversational Video |
| 5 | GBR | 50 | 100 ms | 10^-6 | IMS Signaling |
| 9 | Non-GBR | 90 | 300 ms | 10^-6 | Video streaming |

**NOTE 8**: GBR stands for Guaranteed Bit Rate, Non-GBR means no guaranteed bit rate.
